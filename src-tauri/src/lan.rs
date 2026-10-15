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

struct Room {
    name: String,
    offer: String,
    answer: Option<String>,
    seen: u64,
}

static PORT: OnceLock<u16> = OnceLock::new();

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
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
                        json!({ "id": id, "name": r.name, "taken": r.answer.is_some() })
                    })
                    .collect(),
                Err(_) => Vec::new(),
            };
            (
                200,
                json!({ "host": host, "rooms": list }).to_string(),
            )
        }

        ("GET", "/api/offer") => {
            sweep(rooms);
            let id = query_of(target, "id").unwrap_or_default();
            let found = rooms.lock().ok().and_then(|mut m| {
                let r = m.get_mut(&id)?;
                r.seen = now_secs();
                Some((r.name.clone(), r.offer.clone()))
            });
            match found {
                Some((name, offer)) => (200, json!({ "name": name, "offer": offer }).to_string()),
                None => (404, json!({ "error": "房间不存在或已过期" }).to_string()),
            }
        }

        ("GET", "/api/answer") => {
            sweep(rooms);
            let id = query_of(target, "id").unwrap_or_default();
            let found = rooms.lock().ok().and_then(|mut m| {
                let r = m.get_mut(&id)?;
                r.seen = now_secs();
                Some(r.answer.clone().unwrap_or_default())
            });
            match found {
                Some(a) => (200, json!({ "answer": a }).to_string()),
                None => (404, json!({ "error": "房间不存在或已过期" }).to_string()),
            }
        }

        ("POST", "/api/room") => {
            let v: Value = serde_json::from_str(body).unwrap_or(json!({}));
            let offer = v.get("offer").and_then(|x| x.as_str()).unwrap_or("");
            if offer.is_empty() {
                return (400, json!({ "error": "缺少 offer" }).to_string());
            }
            let id = format!("r{}", now_secs() * 1000 + (Instant::now().elapsed().subsec_millis() as u64));
            let name = v
                .get("name")
                .and_then(|x| x.as_str())
                .unwrap_or(&host)
                .chars()
                .take(24)
                .collect::<String>();
            sweep(rooms);
            if let Ok(mut m) = rooms.lock() {
                m.insert(
                    id.clone(),
                    Room {
                        name,
                        offer: offer.to_string(),
                        answer: None,
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
            sweep(rooms);
            let mut code = 200;
            let mut out = json!({ "ok": true });
            if let Ok(mut m) = rooms.lock() {
                match m.get_mut(id) {
                    None => {
                        code = 404;
                        out = json!({ "error": "房间不存在或已过期" });
                    }
                    Some(r) if r.answer.is_some() => {
                        code = 409;
                        out = json!({ "error": "这个房间已经有人进去了" });
                    }
                    Some(r) => {
                        r.answer = Some(answer.to_string());
                        r.seen = now_secs();
                    }
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
pub fn start() -> Result<u16, String> {
    if let Some(p) = PORT.get() {
        return Ok(*p);
    }

    let listener = TcpListener::bind(("0.0.0.0", PREFERRED_PORT))
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
pub fn lan_start() -> Result<Value, String> {
    let port = start()?;
    Ok(json!({
        "port": port,
        "url": format!("http://127.0.0.1:{}", port),
        "name": hostname(),
    }))
}

#[tauri::command]
pub fn lan_discover(timeout_ms: Option<u64>) -> Vec<Value> {
    discover(Duration::from_millis(timeout_ms.unwrap_or(1500)))
}
