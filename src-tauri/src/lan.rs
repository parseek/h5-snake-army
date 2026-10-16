//! 局域网房间：内嵌一个极小的 HTTP 信令服务 + UDP 广播探测。
//!
//! 为什么必须放在 Rust 侧：浏览器不能监听端口、不能收 UDP 广播、也没有 mDNS 浏览 API，
//! 所以「自动搜索房间」这件事网页永远做不到。这里把「被搜到」和「牵线」补上，
//! 前端仍然是一份能在纯浏览器里跑的静态页面 —— 拿不到原生桥时自动退回手动交换连接码。
//!
//! 接口故意跟 lan-host.py 保持一致（/api/ping、/api/rooms、/api/room、/api/offer、
//! /api/answer），这样前端只有一条代码路径：给它一个 base 地址就行。

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream, UdpSocket};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

/// 探测用的固定 UDP 端口。HTTP 端口是临时分配的，靠应答包回传。
const DISCOVERY_PORT: u16 = 47811;
const PROBE: &[u8] = b"SNAKE-ARMY-DISCOVER/1";
const RESP_PREFIX: &str = "SNAKE-ARMY-HOST/1";
const ROOM_TTL: u64 = 60;
/// 优先用这个端口，被占（例如同机开了第二个实例）再退回系统随机分配。
const PREFERRED_PORT: u16 = 47812;

type Rooms = Arc<Mutex<HashMap<String, Room>>>;

/// 一个座位上的信令：房主放 offer，来客放 answer
struct Seat {
    offer: String,
    answer: Option<String>,
}

struct Room {
    name: String,
    /// 房间描述，房主填，给来客看
    desc: String,
    /// 房主的玩家名
    player: String,
    /// 场地初始宽高（格）
    cols: u16,
    rows: u16,
    /// 玩家上限（含房主）
    max_players: u16,
    /// 现在几个人（含房主）。房主轮询时会顺带报上来。
    players: u16,
    /// 座位号 -> 那一席的信令。座位 1..max_players-1 是玩家席，
    /// 负数（-1、-2…）是观战席 —— 玩家席满了还能进来看。
    seats: HashMap<i16, Seat>,
    seen: u64,
}

impl Room {
    /// 玩家席里「有 offer、还没人应答」的还剩几个
    fn free_player_seats(&self) -> u16 {
        (1..self.max_players)
            .filter(|s| self.seats.get(&(*s as i16)).map(|x| x.answer.is_none()).unwrap_or(false))
            .count() as u16
    }

    fn answered_player_seats(&self) -> u16 {
        self.seats
            .iter()
            .filter(|(s, x)| **s > 0 && x.answer.is_some())
            .count() as u16
    }

    fn spectators(&self) -> u16 {
        self.seats
            .iter()
            .filter(|(s, x)| **s < 0 && x.answer.is_some())
            .count() as u16
    }

    fn free_spectator_seats(&self) -> u16 {
        self.seats
            .iter()
            .filter(|(s, x)| **s < 0 && x.answer.is_none())
            .count() as u16
    }

    /// 现在几个人：房主 + 已经应答的玩家席，跟房主报上来的取大的那个
    fn live_players(&self) -> u16 {
        self.players.max(1 + self.answered_player_seats())
    }

    /// 下一个能坐的座位：先玩家席，再观战席；都没有就 None
    fn take_seat(&self) -> Option<i16> {
        for s in 1..self.max_players {
            let s = s as i16;
            if self.seats.get(&s).map(|x| x.answer.is_none()).unwrap_or(false) {
                return Some(s);
            }
        }
        let mut spec: Vec<i16> = self
            .seats
            .iter()
            .filter(|(s, x)| **s < 0 && x.answer.is_none())
            .map(|(s, _)| *s)
            .collect();
        spec.sort_unstable_by(|a, b| b.cmp(a)); // -1 优先，-2 次之
        spec.first().copied()
    }
}

static PORT: OnceLock<u16> = OnceLock::new();

/// 空字符串就退回 fallback，省得房间名/玩家名变成空白条目
trait IfEmpty {
    fn if_empty(self, fallback: &str) -> String;
}

impl IfEmpty for String {
    fn if_empty(self, fallback: &str) -> String {
        if self.is_empty() {
            fallback.to_string()
        } else {
            self
        }
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 本机在局域网里的地址：连一个外网地址但不真发数据，看内核选了哪张网卡。
fn lan_ip() -> String {
    let s = match UdpSocket::bind(("0.0.0.0", 0)) {
        Ok(s) => s,
        Err(_) => return "127.0.0.1".to_string(),
    };
    match s.connect(("8.8.8.8", 80)) {
        Ok(_) => s
            .local_addr()
            .map(|a| a.ip().to_string())
            .unwrap_or_else(|_| "127.0.0.1".to_string()),
        Err(_) => "127.0.0.1".to_string(),
    }
}

fn hostname() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "snake-host".to_string())
}

fn sweep(rooms: &Rooms) {
    let t = now_secs();
    if let Ok(mut m) = rooms.lock() {
        m.retain(|_, r| t.saturating_sub(r.seen) <= ROOM_TTL);
    }
}

// ---------------------------------------------------------------- HTTP

fn respond(stream: &mut TcpStream, code: u16, body: &str) {
    let head = format!(
        "HTTP/1.1 {} {}\r\n\
         Content-Type: application/json; charset=utf-8\r\n\
         Content-Length: {}\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Access-Control-Allow-Headers: *\r\n\
         Access-Control-Allow-Methods: GET,POST,OPTIONS\r\n\
         Cache-Control: no-store\r\n\
         Connection: close\r\n\r\n",
        code,
        if code == 200 { "OK" } else { "Error" },
        body.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body.as_bytes());
    let _ = stream.flush();
}

fn urldecode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'%' if i + 2 < b.len() => {
                let hex = std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or("");
                match u8::from_str_radix(hex, 16) {
                    Ok(v) => {
                        out.push(v);
                        i += 3;
                    }
                    Err(_) => {
                        out.push(b[i]);
                        i += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

fn query_of(target: &str, key: &str) -> Option<String> {
    let q = target.split_once('?')?.1;
    for kv in q.split('&') {
        if let Some((k, v)) = kv.split_once('=') {
            if k == key {
                return Some(urldecode(v));
            }
        }
    }
    None
}

fn route(method: &str, target: &str, body: &str, rooms: &Rooms) -> (u16, String) {
    let path = target.split('?').next().unwrap_or("/");
    let host = hostname();

    if method == "OPTIONS" {
        return (200, "{}".to_string());
    }

    match (method, path) {
        ("GET", "/api/ping") => (200, json!({ "ok": true, "name": host }).to_string()),

        ("GET", "/api/rooms") => {
            sweep(rooms);
            let list: Vec<Value> = match rooms.lock() {
                Ok(m) => m
                    .iter()
                    .map(|(id, r)| {
                        json!({
                            "id": id,
                            "name": r.name,
                            "desc": r.desc,
                            "player": r.player,
                            "cols": r.cols,
                            "rows": r.rows,
                            "maxPlayers": r.max_players,
                            "players": r.live_players(),
                            "spectators": r.spectators(),
                            "freeSeats": r.free_player_seats(),
                            "freeSpectatorSeats": r.free_spectator_seats(),
                            // 观战席都没了才算「进不去」
                            "taken": r.free_player_seats() == 0 && r.free_spectator_seats() == 0,
                        })
                    })
                    .collect(),
                Err(_) => Vec::new(),
            };
            (
                200,
                json!({ "host": host, "rooms": list }).to_string(),
            )
        }

        // 来客取座位：给一个「有 offer、还没人应答」的座位（先玩家席，再观战席）
        ("GET", "/api/offer") => {
            sweep(rooms);
            let id = query_of(target, "id").unwrap_or_default();
            let found = rooms.lock().ok().and_then(|mut m| {
                let r = m.get_mut(&id)?;
                r.seen = now_secs();
                let seat = r.take_seat()?;
                let offer = r.seats.get(&seat).map(|s| s.offer.clone()).unwrap_or_default();
                Some((r.name.clone(), seat, offer))
            });
            match found {
                Some((name, seat, offer)) => (
                    200,
                    json!({ "name": name, "seat": seat, "offer": offer }).to_string(),
                ),
                None => (409, json!({ "error": "座位都满了" }).to_string()),
            }
        }

        // 房主把某个座位的 offer 挂上来（每个座位一份）
        ("POST", "/api/offer") => {
            let v: Value = serde_json::from_str(body).unwrap_or(json!({}));
            let id = v.get("id").and_then(|x| x.as_str()).unwrap_or("");
            let offer = v.get("offer").and_then(|x| x.as_str()).unwrap_or("");
            let seat = v.get("seat").and_then(|x| x.as_i64()).unwrap_or(0) as i16;
            if offer.is_empty() {
                return (400, json!({ "error": "缺少 offer" }).to_string());
            }
            sweep(rooms);
            let mut code = 200;
            let mut out = json!({ "ok": true });
            if let Ok(mut m) = rooms.lock() {
                match m.get_mut(id) {
                    None => {
                        code = 404;
                        out = json!({ "error": "房间不存在或已过期" });
                    }
                    Some(r) => {
                        r.seen = now_secs();
                        r.seats.insert(
                            seat,
                            Seat {
                                offer: offer.to_string(),
                                answer: None,
                            },
                        );
                    }
                }
            }
            (code, out.to_string())
        }

        // 房主轮询：哪些座位已经有人应答了。
        // 故意「读不消费」——网络抖一下就丢一张应答码的坑不值得踩；
        // 房主那边按座位去重就够了。
        ("GET", "/api/answers") => {
            sweep(rooms);
            let id = query_of(target, "id").unwrap_or_default();
            // 房主每 700ms 轮询一次，顺带把「现在几个人」报上来，
            // 来客在房间列表里才能看到实时人数。
            let reported = query_of(target, "players").and_then(|v| v.parse::<u16>().ok());
            let found = rooms.lock().ok().and_then(|mut m| {
                let r = m.get_mut(&id)?;
                r.seen = now_secs();
                if let Some(n) = reported {
                    r.players = n.max(1);
                }
                let mut list: Vec<(i16, String)> = r
                    .seats
                    .iter()
                    .filter_map(|(s, x)| x.answer.clone().map(|a| (*s, a)))
                    .collect();
                list.sort_by_key(|(s, _)| *s);
                Some(list)
            });
            match found {
                Some(list) => {
                    let arr: Vec<Value> = list
                        .into_iter()
                        .map(|(s, a)| json!({ "seat": s, "answer": a }))
                        .collect();
                    (200, json!({ "answers": arr }).to_string())
                }
                None => (404, json!({ "error": "房间不存在或已过期" }).to_string()),
            }
        }

        ("POST", "/api/room") => {
            let v: Value = serde_json::from_str(body).unwrap_or(json!({}));
            // 加个自增序号：同一毫秒里建两个房间也不会撞 id（测试里踩到过）
            static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed) % 1000;
            let id = format!(
                "r{}{:03}",
                now_secs() * 1000 + (Instant::now().elapsed().subsec_millis() as u64),
                seq
            );
            let take = |k: &str, max: usize, fallback: &str| -> String {
                v.get(k)
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .trim()
                    .chars()
                    .take(max)
                    .collect::<String>()
                    .trim()
                    .to_string()
                    .if_empty(fallback)
            };
            let num = |k: &str, lo: u16, hi: u16, dflt: u16| -> u16 {
                v.get(k)
                    .and_then(|x| x.as_u64())
                    .map(|n| n as u16)
                    .unwrap_or(dflt)
                    .clamp(lo, hi)
            };
            let cols = num("cols", 10, 60, 30);
            let rows = num("rows", 8, 40, 15);
            let max_players = num("maxPlayers", 2, 6, 2);
            let name = take("name", 24, &host);
            let desc = take("desc", 80, "");
            let player = take("player", 16, &host);
            sweep(rooms);
            if let Ok(mut m) = rooms.lock() {
                m.insert(
                    id.clone(),
                    Room {
                        name,
                        desc,
                        player,
                        cols,
                        rows,
                        max_players,
                        players: 1,          // 一开始只有房主
                        seats: HashMap::new(), // 座位由房主一个个挂上来
                        seen: now_secs(),
                    },
                );
            }
            (200, json!({ "id": id }).to_string())
        }

        ("POST", "/api/answer") => {
            let v: Value = serde_json::from_str(body).unwrap_or(json!({}));
            let id = v.get("id").and_then(|x| x.as_str()).unwrap_or("");
            let answer = v.get("answer").and_then(|x| x.as_str()).unwrap_or("");
            let seat = v.get("seat").and_then(|x| x.as_i64()).unwrap_or(0) as i16;
            if answer.is_empty() {
                return (400, json!({ "error": "缺少 answer" }).to_string());
            }
            sweep(rooms);
            let mut code = 200;
            let mut out = json!({ "ok": true });
            if let Ok(mut m) = rooms.lock() {
                match m.get_mut(id) {
                    None => {
                        code = 404;
                        out = json!({ "error": "房间不存在或已过期" });
                    }
                    Some(r) => match r.seats.get_mut(&seat) {
                        None => {
                            code = 400;
                            out = json!({ "error": "这个座位没有对应的 offer" });
                        }
                        Some(s) if s.answer.is_some() => {
                            code = 409;
                            out = json!({ "error": "这个座位刚被人坐下了" });
                        }
                        Some(s) => {
                            s.answer = Some(answer.to_string());
                            r.seen = now_secs();
                        }
                    },
                }
            }
            (code, out.to_string())
        }

        ("POST", "/api/close") => {
            let v: Value = serde_json::from_str(body).unwrap_or(json!({}));
            if let Some(id) = v.get("id").and_then(|x| x.as_str()) {
                if let Ok(mut m) = rooms.lock() {
                    m.remove(id);
                }
            }
            (200, json!({ "ok": true }).to_string())
        }

        _ => (404, json!({ "error": "not found" }).to_string()),
    }
}

fn handle_conn(stream: TcpStream, rooms: Rooms) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));

    let clone = match stream.try_clone() {
        Ok(c) => c,
        Err(_) => return,
    };
    let mut reader = BufReader::new(clone);
    let mut stream = stream;

    let mut line = String::new();
    if reader.read_line(&mut line).is_err() {
        return;
    }
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let target = parts.next().unwrap_or("/").to_string();

    let mut len = 0usize;
    loop {
        let mut h = String::new();
        if reader.read_line(&mut h).is_err() {
            return;
        }
        let t = h.trim_end();
        if t.is_empty() {
            break;
        }
        let lower = t.to_ascii_lowercase();
        if let Some(v) = lower.strip_prefix("content-length:") {
            len = v.trim().parse().unwrap_or(0);
        }
    }

    let mut buf = vec![0u8; len.min(1 << 20)];
    let body = if len > 0 && reader.read_exact(&mut buf).is_ok() {
        String::from_utf8_lossy(&buf).to_string()
    } else {
        String::new()
    };

    let (code, text) = route(&method, &target, &body, &rooms);
    respond(&mut stream, code, &text);
}

// ---------------------------------------------------------------- UDP 探测

fn udp_responder(tcp_port: u16, rooms: Rooms) {
    let sock = match UdpSocket::bind(("0.0.0.0", DISCOVERY_PORT)) {
        Ok(s) => s,
        // 端口被占（例如同机开了第二个实例）就安静地不做应答，其它功能照常
        Err(_) => return,
    };
    let _ = sock.set_broadcast(true);

    let mut buf = [0u8; 128];
    loop {
        let (n, from) = match sock.recv_from(&mut buf) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if &buf[..n] != PROBE {
            continue;
        }
        sweep(&rooms);
        let count = rooms.lock().map(|m| m.len()).unwrap_or(0);
        let payload = json!({
            "name": hostname(),
            "port": tcp_port,
            "rooms": count,
        });
        let reply = format!("{} {}", RESP_PREFIX, payload);
        let _ = sock.send_to(reply.as_bytes(), from);
    }
}

// ---------------------------------------------------------------- 对外

/// 起内嵌信令服务，返回 HTTP 端口。重复调用返回同一个端口。
///
/// 端口由房主在界面上定（默认随机一个），被占就退回系统随机分配 ——
/// 所以不主动在开机时启动：只在真的开房那一刻起，端口才是房主要的那个。
pub fn start(port: Option<u16>) -> Result<u16, String> {
    if let Some(p) = PORT.get() {
        return Ok(*p);
    }

    let want = port.unwrap_or(PREFERRED_PORT);
    let listener = TcpListener::bind(("0.0.0.0", want))
        .or_else(|_| TcpListener::bind(("0.0.0.0", 0)))
        .map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();

    let rooms: Rooms = Arc::new(Mutex::new(HashMap::new()));

    {
        let rooms = Arc::clone(&rooms);
        std::thread::spawn(move || {
            for conn in listener.incoming() {
                if let Ok(s) = conn {
                    let rooms = Arc::clone(&rooms);
                    std::thread::spawn(move || handle_conn(s, rooms));
                }
            }
        });
    }
    {
        let rooms = Arc::clone(&rooms);
        std::thread::spawn(move || udp_responder(port, rooms));
    }

    let _ = PORT.set(port);
    Ok(port)
}

/// 广播探测局域网里开着房间的机器。
pub fn discover(timeout: Duration) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let sock = match UdpSocket::bind(("0.0.0.0", 0)) {
        Ok(s) => s,
        Err(_) => return out,
    };
    let _ = sock.set_broadcast(true);
    let _ = sock.set_read_timeout(Some(Duration::from_millis(200)));

    // 广播地址；某些网络禁广播，那就只剩下面那条回环
    let _ = sock.send_to(PROBE, ("255.255.255.255", DISCOVERY_PORT));
    // 回环也发一份：同机多开时能自己发现自己的另一个实例，方便自测
    let _ = sock.send_to(PROBE, ("127.0.0.1", DISCOVERY_PORT));

    let deadline = Instant::now() + timeout;
    let mut buf = [0u8; 512];
    while Instant::now() < deadline {
        match sock.recv_from(&mut buf) {
            Ok((n, from)) => {
                let text = String::from_utf8_lossy(&buf[..n]).to_string();
                let Some(rest) = text.strip_prefix(RESP_PREFIX) else {
                    continue;
                };
                let info: Value = serde_json::from_str(rest.trim()).unwrap_or(json!({}));
                let ip = from.ip().to_string();
                let port = info.get("port").and_then(|v| v.as_u64()).unwrap_or(0);
                if port == 0 {
                    continue;
                }
                // 同一台机器可能被广播和回环各回一次，去重
                if out.iter().any(|v| {
                    v.get("ip").and_then(|x| x.as_str()) == Some(ip.as_str())
                        && v.get("port").and_then(|x| x.as_u64()) == Some(port)
                }) {
                    continue;
                }
                out.push(json!({
                    "ip": ip,
                    "port": port,
                    "name": info.get("name").and_then(|v| v.as_str()).unwrap_or("?"),
                    "rooms": info.get("rooms").and_then(|v| v.as_u64()).unwrap_or(0),
                    "url": format!("http://{}:{}", ip, port),
                }));
            }
            Err(_) => { /* 读超时，继续等剩下的时间 */ }
        }
    }
    out
}

// ---------------------------------------------------------------- Tauri 命令

#[tauri::command]
pub fn lan_start(port: Option<u16>) -> Result<Value, String> {
    let port = start(port)?;
    let ip = lan_ip();
    Ok(json!({
        "port": port,
        "url": format!("http://127.0.0.1:{}", port),
        "name": hostname(),
        // 房主要把这个地址发给对方（界面上直接显示 ip:port）
        "lanIp": ip,
        "share": format!("{}:{}", ip, port),
        "ips": [ip],
    }))
}

#[tauri::command]
pub fn lan_discover(timeout_ms: Option<u64>) -> Vec<Value> {
    discover(Duration::from_millis(timeout_ms.unwrap_or(1500)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn http(port: u16, method: &str, path: &str, body: &str) -> (u16, String) {
        let mut s = TcpStream::connect(("127.0.0.1", port)).expect("连不上内嵌服务");
        let req = format!(
            "{} {} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            method,
            path,
            body.len(),
            body
        );
        s.write_all(req.as_bytes()).unwrap();
        let mut r = String::new();
        let _ = s.read_to_string(&mut r);
        let code: u16 = r
            .split_whitespace()
            .nth(1)
            .and_then(|c| c.parse().ok())
            .unwrap_or(0);
        (code, r.split("\r\n\r\n").nth(1).unwrap_or("").to_string())
    }

    #[test]
    fn room_metadata_and_seats() {
        let port = start(Some(47899)).expect("起服务失败");
        println!("port = {}", port);
        assert_eq!(port, 47899, "房主指定的端口应当被采用");

        assert_eq!(http(port, "GET", "/api/ping", "").0, 200);

        // 建房不再需要 offer：座位是房主一个个挂上来的
        let (code, body) = http(
            port,
            "POST",
            "/api/room",
            r#"{"name":"小王的车队","desc":"随便玩，别撞墙","player":"阿强","cols":30,"rows":15,"maxPlayers":3}"#,
        );
        assert_eq!(code, 200);
        println!("建房返回 = {}", body);
        let id = serde_json::from_str::<Value>(&body).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string();

        // maxPlayers=3 -> 玩家席 1、2；另外挂一个观战席 -1
        for (seat, tag) in [(1i16, "A"), (2, "B"), (-1, "S")] {
            let b = format!(
                r#"{{"id":"{}","seat":{},"offer":"SNK#1.0.0#O#{}"}}"#,
                id, seat, tag
            );
            assert_eq!(http(port, "POST", "/api/offer", &b).0, 200, "挂 offer 失败 seat={}", seat);
        }

        let (_, list) = http(port, "GET", "/api/rooms", "");
        println!("房间列表 = {}", list);
        let v: Value = serde_json::from_str(&list).unwrap();
        let room = v["rooms"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["id"] == id.as_str())
            .unwrap();
        assert_eq!(room["name"], "小王的车队");
        assert_eq!(room["desc"], "随便玩，别撞墙");
        assert_eq!(room["player"], "阿强");
        assert_eq!(room["maxPlayers"], 3);
        assert_eq!(room["players"], 1);
        assert_eq!(room["freeSeats"], 2);
        assert_eq!(room["spectators"], 0);
        assert_eq!(room["taken"], false);

        // 来客取座位：先给玩家席 1
        let (c1, b1) = http(port, "GET", &format!("/api/offer?id={}", id), "");
        assert_eq!(c1, 200);
        println!("取座位 = {}", b1);
        let v1: Value = serde_json::from_str(&b1).unwrap();
        assert_eq!(v1["seat"], 1);
        assert!(v1["offer"].as_str().unwrap().ends_with('A'));

        // 递回答应码；同一个座位再递一次要挡住（409），否则两个人会坐同一条蛇
        let ans = format!(r#"{{"id":"{}","seat":1,"answer":"SNK#1.0.0#A#X"}}"#, id);
        assert_eq!(http(port, "POST", "/api/answer", &ans).0, 200);
        assert_eq!(http(port, "POST", "/api/answer", &ans).0, 409);

        // 房主轮询能看到谁应答了（读不消费，重复拿到也没关系）
        let (_, ba) = http(port, "GET", &format!("/api/answers?id={}&players=2", id), "");
        println!("应答列表 = {}", ba);
        let va: Value = serde_json::from_str(&ba).unwrap();
        assert_eq!(va["answers"][0]["seat"], 1);
        assert!(va["answers"][0]["answer"].as_str().unwrap().ends_with('X'));
        let (_, ba2) = http(port, "GET", &format!("/api/answers?id={}&players=2", id), "");
        assert_eq!(
            serde_json::from_str::<Value>(&ba2).unwrap()["answers"][0]["seat"],
            1,
            "应答应当可以被重复读到"
        );

        let (_, list2) = http(port, "GET", "/api/rooms", "");
        let v2: Value = serde_json::from_str(&list2).unwrap();
        let room2 = v2["rooms"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["id"] == id.as_str())
            .unwrap();
        assert_eq!(room2["players"], 2, "有人应答后人数应当变成 2");
        assert_eq!(room2["freeSeats"], 1);

        // 下一位拿座位 2；玩家席满了以后再来的人给观战席
        let (_, b2) = http(port, "GET", &format!("/api/offer?id={}", id), "");
        assert_eq!(serde_json::from_str::<Value>(&b2).unwrap()["seat"], 2);
        let ans2 = format!(r#"{{"id":"{}","seat":2,"answer":"SNK#1.0.0#A#Y"}}"#, id);
        assert_eq!(http(port, "POST", "/api/answer", &ans2).0, 200);
        let (_, b3) = http(port, "GET", &format!("/api/offer?id={}", id), "");
        println!("玩家席满了以后 = {}", b3);
        assert_eq!(
            serde_json::from_str::<Value>(&b3).unwrap()["seat"],
            -1,
            "玩家席满了应当给观战席"
        );

        // 座位还没挂 offer 就来递答案：明确报错，别把房间搞乱
        let bad = format!(r#"{{"id":"{}","seat":9,"answer":"SNK#1.0.0#A#Z"}}"#, id);
        assert_eq!(http(port, "POST", "/api/answer", &bad).0, 400);

        // 房间名只填空格时应当退回主机名，不能变成空条目
        let (_, b4) = http(port, "POST", "/api/room", r#"{"name":"   "}"#);
        let id2 = serde_json::from_str::<Value>(&b4).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string();
        let (_, list3) = http(port, "GET", "/api/rooms", "");
        let v3: Value = serde_json::from_str(&list3).unwrap();
        for r in v3["rooms"].as_array().unwrap() {
            if r["id"] == id2.as_str() {
                println!("空名房间 = {}", r);
                assert!(!r["name"].as_str().unwrap().is_empty(), "名字不该是空的");
                assert_eq!(r["player"].as_str().unwrap(), hostname().as_str());
            }
        }
    }
}
