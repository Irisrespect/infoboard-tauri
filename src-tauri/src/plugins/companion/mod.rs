//! 通用伴随程序启动器
//!
//! 背景：这类工具（网盘下载器等）必须做成独立进程 —— 插件跑在 WebView 里，
//! 不能发请求、不能写文件、不能起进程。原先每个程序都单独写两三个命令
//! （`netdisk_app_launch` / `apiprobe_app_launch` ...），加一个程序就要动一次 `lib.rs`。
//!
//! 两层来源，**对调用方是同一组命令**：
//!
//! 1. **注册表**（[`crate::core::companion::ALL`]）：随安装包发的程序，
//!    有"随包资源 / 仓库副本 / 用户手动指定"三条兜底；
//! 2. **插件自带**（manifest 里的 `companion` 段）：程序就在插件目录里，
//!    路径只由宿主拼出来 —— 所以**新插件不需要宿主认识它**，
//!    导入一个 `.ibplugin` 就能有自己的程序（这是 P3 的目的）。
//!
//! 注意：`id` 仍然是**白名单键**，不是路径。查不到就报错并列出可用 id ——
//! 这组命令不会变成"任何插件都能启动任意程序"的口子：
//! 插件不能传路径，只能启动自己包里那份。
//! 旧的两组专用命令保留，行为等价，不打断已装插件。

use crate::core::companion::{self as core_companion, AppStatus};
use serde::Serialize;
use tauri::AppHandle;

/// `companion_list` 的返回项
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionInfo {
    pub id: String,
    /// 入口文件名（注册表项也是手动指定路径时必须匹配的名字）
    pub entry: String,
    /// 随包资源里的子目录名（插件自带的为 null）
    pub bundled_dir: Option<String>,
    /// `registry` = 注册表（安装包随附）；`plugin` = 插件自带
    pub source: String,
    /// 插件声明的版本（注册表项通常没有）
    pub version: Option<String>,
    /// 入口文件现在是否真的存在
    pub present: bool,
}

fn resolve(id: &str) -> Result<&'static core_companion::AppSpec, String> {
    core_companion::by_id(id).ok_or_else(|| {
        let known: Vec<&str> = core_companion::ALL.iter().map(|s| s.id).collect();
        format!("未知的伴随程序 \"{id}\"。可用: {}", known.join(", "))
    })
}

/// 列出所有可启动的程序：注册表 + 已装插件里声明了 `companion` 的
#[tauri::command]
pub fn companion_list(app: AppHandle) -> Vec<CompanionInfo> {
    let mut out: Vec<CompanionInfo> = core_companion::ALL
        .iter()
        .map(|s| CompanionInfo {
            id: s.id.to_string(),
            entry: s.entry.to_string(),
            bundled_dir: Some(s.bundled_dir.to_string()),
            source: "registry".to_string(),
            version: None,
            present: true,
        })
        .collect();

    for (id, decl) in core_companion::plugin_companions(&app) {
        let present = core_companion::status_by_id(&app, &id)
            .map(|st| st.script.is_some() && st.available)
            .unwrap_or(false);
        out.push(CompanionInfo {
            id,
            entry: decl.entry,
            bundled_dir: None,
            source: "plugin".to_string(),
            version: Some(decl.version),
            present,
        });
    }
    out
}

/// 查询某个伴随程序是否可用（找到入口 + 找到 Python）
#[tauri::command]
pub fn companion_status(app: AppHandle, id: String) -> Result<AppStatus, String> {
    core_companion::status_by_id(&app, &id)
}

/// 启动某个伴随程序（注册表项或插件自带）
#[tauri::command]
pub fn companion_launch(app: AppHandle, id: String) -> Result<String, String> {
    core_companion::launch_by_id(&app, &id)
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
