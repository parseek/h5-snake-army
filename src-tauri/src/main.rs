// Windows 上发布版不要弹出控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    snake_army_lib::run()
}
