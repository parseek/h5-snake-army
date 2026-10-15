//! Tauri 外壳。
//!
//! 这里刻意什么都不做：前端就是一份纯静态页面（根目录的 index.html + assets/），
//! 不调用任何 Tauri API，所以同一份代码用浏览器直接打开也照常能玩。
//! 壳只负责给一个原生窗口和 WebView2。

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("Tauri 启动失败");
}
