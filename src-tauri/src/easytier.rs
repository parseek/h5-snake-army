//! EasyTier 虚拟局域网：把「跨网联机」变成「局域网联机」。
//!
//! 为什么走这条路：WebRTC 在对称 NAT / CGNAT 下打不通，而公共免费 TURN 实测全部失效。
//! EasyTier 会建一张点对点虚拟网卡，让两边进入同一虚拟网段。更关键的是它有一个
//! --enable-udp-broadcast-relay（仅 Windows），会把本机的 UDP 广播转发给对端节点，
//! 官方说明就是「帮助局域网游戏发现房间」—— 正好让我们已经写好的 UDP 搜索跨网生效。
//!
//! 本模块只做四件事：找二进制、拉起来、把日志读出来、停掉。
//! 具体连哪个网络、连哪些节点，全由界面上的参数决定，这里不做任何策略判断。

use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};

use serde_json::{json, Value};

const MAX_LOG: usize = 400;

struct Et {
    child: Option<Child>,
    logs: Vec<String>,
    network: String,
}

static ET: OnceLock<Mutex<Et>> = OnceLock::new();

fn state() -> &'static Mutex<Et> {
    ET.get_or_init(|| {
        Mutex::new(Et {
            child: None,
            logs: Vec::new(),
            network: String::new(),
        })
    })
}

// ---------------------------------------------------------------- 环境

/// 找 easytier-core.exe：先看应用旁边（打包分发的情况），
/// 再看仓库里的 src-tauri/binaries（开发时），最后交给 PATH。
pub fn find_binary() -> Option<PathBuf> {
    let mut cands: Vec<PathBuf> = Vec::new();

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            cands.push(dir.join("easytier-core.exe"));
            cands.push(dir.join("binaries").join("easytier-core.exe"));
        }
    }

    // 编译期就确定好的仓库路径，dev 和 build 都适用
    cands.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join("easytier-core.exe"),
    );

    cands.push(PathBuf::from("easytier-core.exe"));

    cands.into_iter().find(|c| c.exists())
}

/// 是否管理员。用 net session 探测：这是少数不需要额外依赖又能准确区分的办法。
#[cfg(windows)]
pub fn is_admin() -> bool {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    Command::new("net")
        .arg("session")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[cfg(not(windows))]
pub fn is_admin() -> bool {
    true
}

// ---------------------------------------------------------------- 进程

fn push_log(line: String) {
    if let Ok(mut st) = state().lock() {
        st.logs.push(line);
        let n = st.logs.len();
        if n > MAX_LOG {
            st.logs.drain(0..n - MAX_LOG);
        }
    }
}

fn spawn_reader<R: Read + Send + 'static>(reader: R) {
    std::thread::spawn(move || {
        let buf = BufReader::new(reader);
        for line in buf.lines() {
            match line {
                Ok(l) => push_log(l),
                Err(_) => break,
            }
        }
    });
}

fn kill_locked(st: &mut Et) {
    if let Some(mut c) = st.child.take() {
        let _ = c.kill();
        let _ = c.wait();
    }
}

fn stop_inner() {
    if let Ok(mut st) = state().lock() {
        kill_locked(&mut st);
    }
}

/// 从日志里捞出虚拟 IPv4，纯粹为了显示；捞不到也不影响功能。
fn parse_virtual_ip(logs: &[String]) -> Option<String> {
    for line in logs.iter().rev() {
        if !line.to_ascii_lowercase().contains("ipv4") {
            continue;
        }
        let mut cur = String::new();
        for ch in line.chars() {
            if ch.is_ascii_digit() || ch == '.' {
                cur.push(ch);
            } else {
                if cur.matches('.').count() == 3 && cur.len() >= 7 {
                    return Some(cur.clone());
                }
                cur.clear();
            }
        }
        if cur.matches('.').count() == 3 && cur.len() >= 7 {
            return Some(cur);
        }
    }
    None
}

// ---------------------------------------------------------------- Tauri 命令

#[tauri::command]
pub fn et_check() -> Value {
    let bin = find_binary();
    let admin = is_admin();
    json!({
        "found": bin.is_some(),
        "path": bin.as_ref().map(|p| p.display().to_string()).unwrap_or_default(),
        "admin": admin,
        // 建虚拟网卡要管理员；没管理员时前端把话说明白，而不是让人干等
        "ready": bin.is_some() && admin,
    })
}

#[tauri::command]
pub fn et_start(
    network: String,
    secret: String,
    peers: Option<String>,
    broadcast_relay: Option<bool>,
) -> Result<Value, String> {
    let bin = find_binary().ok_or("没找到 easytier-core.exe（先跑一次 npm run fetch:easytier）")?;
    if network.trim().is_empty() {
        return Err("网络名不能为空".into());
    }

    stop_inner();
    if let Ok(mut st) = state().lock() {
        st.logs.clear();
        st.network = network.clone();
    }

    let mut cmd = Command::new(&bin);
    cmd.arg("--network-name")
        .arg(network.trim())
        .arg("--network-secret")
        .arg(if secret.trim().is_empty() {
            "snake-army"
        } else {
            secret.trim()
        })
        // -d：由 EasyTier 自己分配虚拟 IP
        .arg("-d");

    if let Some(p) = peers {
        for one in p.split_whitespace().filter(|s| !s.is_empty()) {
            cmd.arg("-p").arg(one);
        }
    }
    if broadcast_relay.unwrap_or(true) {
        cmd.arg("--enable-udp-broadcast-relay");
    }

    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动 easytier-core 失败：{}", e))?;
    let pid = child.id();
    if let Some(o) = child.stdout.take() {
        spawn_reader(o);
    }
    if let Some(e) = child.stderr.take() {
        spawn_reader(e);
    }
    if let Ok(mut st) = state().lock() {
        st.child = Some(child);
    }

    Ok(json!({ "ok": true, "pid": pid, "bin": bin.display().to_string() }))
}

#[tauri::command]
pub fn et_stop() -> Value {
    stop_inner();
    push_log("—— 已手动停止 EasyTier ——".to_string());
    json!({ "ok": true })
}

#[tauri::command]
pub fn et_status() -> Value {
    let mut running = false;
    let mut pid = 0u64;
    let mut network = String::new();
    let mut logs: Vec<String> = Vec::new();

    if let Ok(mut st) = state().lock() {
        if let Some(c) = st.child.as_mut() {
            match c.try_wait() {
                Ok(Some(_)) => {
                    // 自己退了（常见于没有管理员权限、建不了网卡）
                    st.child = None;
                }
                Ok(None) => {
                    running = true;
                    pid = c.id() as u64;
                }
                Err(_) => {}
            }
        }
        network = st.network.clone();
        logs = st.logs.clone();
    }

    json!({
        "running": running,
        "pid": pid,
        "network": network,
        "virtualIp": parse_virtual_ip(&logs),
        "logs": logs,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_binary() {
        let b = find_binary();
        println!("easytier-core = {:?}", b);
        let p = b.expect("没找到 easytier-core.exe");
        assert!(p.to_string_lossy().contains("easytier-core"));
    }

    #[test]
    fn reports_admin_flag() {
        println!("is_admin = {}", is_admin());
    }

    #[test]
    fn starts_reads_logs_and_stops() {
        match et_start(
            "snake-army-rs-test".to_string(),
            "snaketest123".to_string(),
            None,
            Some(true),
        ) {
            Ok(v) => println!("start = {}", v),
            Err(e) => {
                println!("没起来，跳过：{}", e);
                return;
            }
        }

        std::thread::sleep(std::time::Duration::from_secs(5));
        let st = et_status();
        let logs = st
            .get("logs")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        println!("running = {}", st.get("running").unwrap());
        println!("virtualIp = {:?}", st.get("virtualIp"));
        println!("日志 {} 行，前 10 行：", logs.len());
        for l in logs.iter().take(10) {
            println!("  {}", l.as_str().unwrap_or(""));
        }
        assert!(!logs.is_empty(), "应该能读到 EasyTier 的日志");

        // 日志里有没有能说明「建网卡失败」的线索
        let warn: Vec<String> = logs
            .iter()
            .filter_map(|l| l.as_str())
            .filter(|s| {
                let t = s.to_ascii_lowercase();
                t.contains("error")
                    || t.contains("warn")
                    || t.contains("denied")
                    || t.contains("admin")
            })
            .map(|s| s.to_string())
            .collect();
        println!("异常行 {} 条：", warn.len());
        for l in warn.iter().take(6) {
            println!("  {}", l);
        }

        let _ = et_stop();
        std::thread::sleep(std::time::Duration::from_millis(400));
        let st2 = et_status();
        println!("停止后 running = {}", st2.get("running").unwrap());
        assert_eq!(st2.get("running").unwrap(), &serde_json::json!(false));
    }
}

