//! 「API 中转站测活工具」(api-probe) 的启动后端
//!
//! 这个工具是独立的单文件 Python 程序（tkinter GUI、零第三方依赖），插件只负责把它
//! 拉起来 —— 理由和网盘下载器一样：插件在 WebView 里既不能直接发网络请求，也不能写
//! 文件，而测活工具的核心就是发请求 + 写 Claude Code / Codex 的配置。
//!
//! 与网盘下载器的区别：那个随包分发，这个**不随包**（它有自己的仓库、自己在迭代），
//! 所以多给两个命令让用户手动指定一次 `api_probe.py` 的位置，之后记住。
//! 指定时会校验文件名，免得这个能力被当作"启动任意程序"的口子。

use crate::core::companion::{self, APIPROBE};
use tauri::AppHandle;

#[tauri::command]
pub fn apiprobe_app_status(app: AppHandle) -> companion::AppStatus {
    companion::status(&app, &APIPROBE)
}

#[tauri::command]
pub fn apiprobe_app_launch(app: AppHandle) -> Result<String, String> {
    companion::launch(&app, &APIPROBE)
}

/// 记住用户选定的 `api_probe.py` 路径
#[tauri::command]
pub fn apiprobe_app_set_path(app: AppHandle, path: String) -> Result<companion::AppStatus, String> {
    companion::set_custom_path(&app, &APIPROBE, &path)?;
    Ok(companion::status(&app, &APIPROBE))
}

/// 忘掉手动指定的路径，回到随包 / 自动查找
#[tauri::command]
pub fn apiprobe_app_clear_path(app: AppHandle) -> companion::AppStatus {
    companion::clear_custom_path(&app, &APIPROBE);
    companion::status(&app, &APIPROBE)
}
