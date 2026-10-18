//! 启动独立的网盘下载器
//!
//! 为什么把它做成独立软件而不是继续留在插件里：插件跑在 WebView 中，**只在面板
//! 打开时运行** —— 关掉面板，网盘直链过期（5~10 分钟）就没人来换链，大文件下不完。
//! 独立进程自己就能一直下、自己换链，也不受应用 CSP（不能发请求 / 不能写文件）限制。
//!
//! 所以这个模块只做一件事：找到那个 Python 程序并把它拉起来。
//!
//! 安全上的取舍：**不给插件开放"启动任意程序"的能力**。命令自己去固定的几个位置
//! 找 `netdisk-app/main.py`，插件只能触发"启动它"，不能指定要启动什么。

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Manager};

/// 允许覆盖程序位置（开发时用）
const ENV_OVERRIDE: &str = "INFOBOARD_NETDISK_APP";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStatus {
    /// 能不能启动
    pub available: bool,
    /// 找到的程序入口
    pub script: Option<String>,
    /// 用来运行它的解释器
    pub python: Option<String>,
    /// 给用户看的一句话说明
    pub message: String,
}

/// 依次在几个固定位置找入口脚本
fn find_script(app: &AppHandle) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(p) = std::env::var(ENV_OVERRIDE) {
        if !p.trim().is_empty() {
            candidates.push(PathBuf::from(p));
        }
    }
    // 打包后：资源目录
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.join("netdisk-app").join("main.py"));
        // 有些打包方式会把整个仓库根目录打成资源
        candidates.push(dir.join("netdisk-app"));
    }
    // 开发时：可执行文件在 src-tauri/target/<profile>/，往上找仓库根
    if let Ok(exe) = std::env::current_exe() {
        let mut cur = exe.parent().map(Path::to_path_buf);
        for _ in 0..5 {
            let Some(dir) = cur else { break };
            candidates.push(dir.join("netdisk-app").join("main.py"));
            cur = dir.parent().map(Path::to_path_buf);
        }
    }
    // 最后看当前工作目录
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("netdisk-app").join("main.py"));
    }

    candidates.into_iter().find(|p| p.is_file())
}

/// 找一个"不弹黑框"的 Python 解释器
///
/// 优先 `pythonw.exe` / `pyw.exe`：它们是窗口子系统程序，不会额外弹一个控制台。
fn find_python() -> Option<PathBuf> {
    // 显式指定优先
    if let Ok(p) = std::env::var("INFOBOARD_PYTHON") {
        let path = PathBuf::from(p);
        if path.is_file() {
            return Some(path);
        }
    }

    let names: &[&str] = if cfg!(windows) {
        &["pythonw.exe", "python.exe", "pyw.exe", "py.exe"]
    } else {
        &["python3", "python"]
    };

    // PATH 上按顺序找
    if let Some(paths) = std::env::var_os("PATH") {
        let dirs: Vec<PathBuf> = std::env::split_paths(&paths).collect();
        for name in names {
            for dir in &dirs {
                let candidate = dir.join(name);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }

    // Windows 上常见的按用户安装位置（PATH 里常常没有）
    #[cfg(windows)]
    {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            let base = PathBuf::from(local).join("Programs").join("Python");
            if let Ok(entries) = std::fs::read_dir(&base) {
                let mut found: Vec<PathBuf> = entries
                    .flatten()
                    .map(|e| e.path().join("pythonw.exe"))
                    .filter(|p| p.is_file())
                    .collect();
                // Python314 要排在 Python39 前面：按名字倒序近似取新版本
                found.sort();
                if let Some(p) = found.pop() {
                    return Some(p);
                }
            }
        }
    }
    None
}

fn status_of(app: &AppHandle) -> AppStatus {
    let script = find_script(app);
    let python = find_python();
    match (&script, &python) {
        (Some(s), Some(p)) => AppStatus {
            available: true,
            script: Some(s.to_string_lossy().to_string()),
            python: Some(p.to_string_lossy().to_string()),
            message: "已就绪".to_string(),
        },
        (None, _) => AppStatus {
            available: false,
            script: None,
            python: python.map(|p| p.to_string_lossy().to_string()),
            message: "没找到 netdisk-app/main.py（可把它放在应用旁边，或用 INFOBOARD_NETDISK_APP 指定路径）"
                .to_string(),
        },
        (Some(s), None) => AppStatus {
            available: false,
            script: Some(s.to_string_lossy().to_string()),
            python: None,
            message: "找到了程序，但没找到 Python 解释器（需要 Python 3.10+，且自带 tkinter）"
                .to_string(),
        },
    }
}

#[tauri::command]
pub fn netdisk_app_status(app: AppHandle) -> AppStatus {
    status_of(&app)
}

/// 启动独立下载器（已经启动过再点一次也无害，会开新窗口）
#[tauri::command]
pub fn netdisk_app_launch(app: AppHandle) -> Result<String, String> {
    let status = status_of(&app);
    if !status.available {
        return Err(status.message);
    }
    let script = status.script.clone().unwrap_or_default();
    let python = status.python.clone().unwrap_or_default();

    let mut cmd = Command::new(&python);
    cmd.arg(&script);
    // 工作目录设成程序所在目录，这样它自己的相对路径也找得到
    if let Some(dir) = Path::new(&script).parent() {
        cmd.current_dir(dir);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // DETACHED_PROCESS：不跟着主程序退出，也不弹控制台
        cmd.creation_flags(0x0000_0008);
    }

    let child = cmd
        .spawn()
        .map_err(|e| format!("启动失败（{python}）：{e}"))?;

    crate::core::app_log::emit(
        &app,
        "info",
        &format!("[netdisk] 已启动独立下载器 pid={}", child.id()),
    );
    Ok(format!("已启动网盘下载器（pid {}）", child.id()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn python_名字按平台取() {
        // 只验证"能返回一个候选列表而不 panic"；具体命中哪个取决于机器
        let _ = find_python();
    }
}
