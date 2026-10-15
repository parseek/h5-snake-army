//! Tauri 外壳。
//!
//! 前端仍然是一份纯静态页面（根目录的 index.html + assets/），不调用任何 Tauri API
//! 也能在浏览器里跑。壳这边只补两件浏览器做不到的事：
//!   * 开一个原生窗口
//!   * 局域网房间：内嵌信令服务 + UDP 广播探测（见 lan.rs）

mod lan;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 开机就把局域网服务挂上：这样别人一搜就能看到这台机器（哪怕还没点「开个房间」）
    let _ = lan::start();

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![lan::lan_start, lan::lan_discover])
        .run(tauri::generate_context!())
        .expect("Tauri 启动失败");
}
