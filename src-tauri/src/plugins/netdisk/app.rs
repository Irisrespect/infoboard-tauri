//! 启动独立的网盘下载器
//!
//! 为什么把它做成独立软件而不是继续留在插件里：插件跑在 WebView 中，**只在面板
//! 打开时运行** —— 关掉面板，网盘直链过期（5~10 分钟）就没人来换链，大文件下不完。
//! 独立进程自己就能一直下、自己换链，也不受应用 CSP（不能发请求 / 不能写文件）限制。
//!
//! 找程序、找解释器、启动这些都在 `core::companion` 里共用，这里只绑定
//! "网盘下载器"这一个程序 —— 插件因此只能启动它自己那一个，借不了道去启动别的。

use crate::core::companion::{self, NETDISK};
use tauri::AppHandle;

#[tauri::command]
pub fn netdisk_app_status(app: AppHandle) -> companion::AppStatus {
    companion::status(&app, &NETDISK)
}

#[tauri::command]
pub fn netdisk_app_launch(app: AppHandle) -> Result<String, String> {
    companion::launch(&app, &NETDISK)
}
