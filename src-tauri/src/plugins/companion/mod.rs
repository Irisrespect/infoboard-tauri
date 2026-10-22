//! 通用伴随程序启动器
//!
//! 背景：这类工具（网盘下载器等）必须做成独立进程 —— 插件跑在 WebView 里，
//! 不能发请求、不能写文件、不能起进程。原先每个程序都单独写两三个命令
//! （`netdisk_app_launch` / `apiprobe_app_launch` ...），加一个程序就要动一次 `lib.rs`。
//!
//! 这里改成**按 id 查注册表**的一组通用命令，新程序只需要在
//! [`crate::core::companion::ALL`] 里登记一个 [`crate::core::companion::AppSpec`]。
//!
//! 注意：`id` 是**白名单键**，不是路径。查不到就报错并列出可用 id ——
//! 所以这组命令不会变成"任何插件都能启动任意程序"的口子。
//! 旧的两组专用命令保留，行为等价，不打断已装插件。

use crate::core::companion::{self as core_companion, AppStatus};
use serde::Serialize;
use tauri::AppHandle;

/// `companion_list` 的返回项
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionInfo {
    pub id: &'static str,
    /// 入口文件名（也是手动指定路径时必须匹配的名字）
    pub entry: &'static str,
    pub bundled_dir: &'static str,
}

fn resolve(id: &str) -> Result<&'static core_companion::AppSpec, String> {
    core_companion::by_id(id).ok_or_else(|| {
        let known: Vec<&str> = core_companion::ALL.iter().map(|s| s.id).collect();
        format!("未知的伴随程序 \"{id}\"。可用: {}", known.join(", "))
    })
}

/// 列出所有已注册的伴随程序
#[tauri::command]
pub fn companion_list() -> Vec<CompanionInfo> {
    core_companion::ALL
        .iter()
        .map(|s| CompanionInfo {
            id: s.id,
            entry: s.entry,
            bundled_dir: s.bundled_dir,
        })
        .collect()
}

/// 查询某个伴随程序是否可用（找到入口 + 找到 Python）
#[tauri::command]
pub fn companion_status(app: AppHandle, id: String) -> Result<AppStatus, String> {
    let spec = resolve(&id)?;
    Ok(core_companion::status(&app, spec))
}

/// 启动某个伴随程序
#[tauri::command]
pub fn companion_launch(app: AppHandle, id: String) -> Result<String, String> {
    let spec = resolve(&id)?;
    core_companion::launch(&app, spec)
}

/// 记住用户手动指定的入口脚本（文件名必须与注册表里的 `entry` 一致）
#[tauri::command]
pub fn companion_set_path(app: AppHandle, id: String, path: String) -> Result<AppStatus, String> {
    let spec = resolve(&id)?;
    core_companion::set_custom_path(&app, spec, &path)?;
    Ok(core_companion::status(&app, spec))
}

/// 忘掉手动指定的路径，回到随包 / 自动查找
#[tauri::command]
pub fn companion_clear_path(app: AppHandle, id: String) -> Result<AppStatus, String> {
    let spec = resolve(&id)?;
    core_companion::clear_custom_path(&app, spec);
    Ok(core_companion::status(&app, spec))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 注册表里的id都能解析() {
        for spec in core_companion::ALL {
            assert!(resolve(spec.id).is_ok(), "{}", spec.id);
        }
    }

    #[test]
    fn 未知id报错并列出可用项() {
        let err = resolve("nope").unwrap_err();
        assert!(err.contains("netdisk"), "{err}");
        assert!(err.contains("bilidl"), "{err}");
    }
}
