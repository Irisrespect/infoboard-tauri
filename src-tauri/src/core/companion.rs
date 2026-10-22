//! 启动"伴随程序"（外部小工具）
//!
//! 有些工具不适合塞进插件里跑：InfoBoard 的插件运行在 WebView 中，受应用 CSP 限制
//! （不能直接发网络请求、不能写文件），而且只在面板打开时活着。这类工具做成独立的
//! Python 程序更合适，插件只负责把它们拉起来。
//!
//! 这里放的是两条链路共用的逻辑：
//! - 找解释器（优先 `pythonw`，不弹黑框）
//! - 找入口脚本：先看随包资源，再看用户手动指定的路径
//! - 记住用户指定的路径（`companion-apps.json`）
//!
//! 启动入口分两层：
//!
//! - **注册表**（[`ALL`]）：每个伴随程序一个 [`AppSpec`]。新增程序 = 加一个常量 +
//!   在 [`ALL`] 里登记一行。
//! - **通用命令**（`companion_status` / `companion_launch` / ...，见
//!   `plugins::companion`）：按 `id` 去注册表里查，查不到就报错。因此它虽然"通用"，
//!   仍然只是**白名单**的一种写法 —— 装进来的第三方插件没法借它启动任意程序。
//!
//! 旧的两组专用命令（`netdisk_app_launch` / `apiprobe_app_launch`）保留不动：
//! 它们直接引用具体常量，等价于 `companion_launch("netdisk")`，删了会打断已有插件。
//!
//! 手动指定路径时会校验**文件名**必须是该程序约定的入口名（如 `api_probe.py`），
//! 免得这个能力被当成"启动任意程序"的入口用。

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Manager};

/// 一个伴随程序的约定
///
/// `Debug` 不是装饰：`by_id` 返回 `Option<&AppSpec>`，测试里对 `Result<_, String>`
/// 调 `unwrap_err()` 需要 `T: Debug`（`T = &AppSpec`）。字段全是 `&'static str`，
/// 派生 `Clone`/`Copy` 也顺手 —— 这个结构本来就是编译期常量。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AppSpec {
    /// 标识，用于配置文件分组
    pub id: &'static str,
    /// 入口文件名（也是手动指定路径时要匹配的名字）
    pub entry: &'static str,
    /// 随包资源里的子目录名
    pub bundled_dir: &'static str,
}

/// 网盘下载器
pub const NETDISK: AppSpec = AppSpec {
    id: "netdisk",
    entry: "main.py",
    bundled_dir: "netdisk-app",
};

/// API 中转站测活工具
pub const APIPROBE: AppSpec = AppSpec {
    id: "apiprobe",
    entry: "api_probe.py",
    bundled_dir: "api-probe",
};

/// B 站下载器（tkinter 独立程序，仓库内 `bili-dl-app/`）
pub const BILIDL: AppSpec = AppSpec {
    id: "bilidl",
    entry: "bili_dl.py",
    bundled_dir: "bili-dl-app",
};

/// 所有可被通用命令启动的伴随程序。
///
/// 这是**白名单**：`companion_launch` 只接受这里出现过的 `id`，
/// 因此"通用"不等于"能启动任意程序"。
pub const ALL: &[&AppSpec] = &[&NETDISK, &APIPROBE, &BILIDL];

/// 按 `id` 查注册表
pub fn by_id(id: &str) -> Option<&'static AppSpec> {
    ALL.iter().copied().find(|spec| spec.id == id)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStatus {
    pub available: bool,
    /// 找到的入口脚本
    pub script: Option<String>,
    /// 用来运行它的解释器
    pub python: Option<String>,
    /// 入口来自哪里：`bundled`（随包）还是 `custom`（用户指定）
    pub source: Option<String>,
    /// 给用户看的一句话
    pub message: String,
}

// ─── 解释器 ───

/// 找一个"不弹黑框"的 Python 解释器
///
/// 优先 `pythonw.exe` / `pyw.exe`：窗口子系统程序，不会额外弹一个控制台。
pub fn find_python() -> Option<PathBuf> {
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

    // Windows 上按用户安装的位置（PATH 里常常没有）
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
                // Python314 排在 Python39 前面：按名字倒序近似取新版本
                found.sort();
                if let Some(p) = found.pop() {
                    return Some(p);
                }
            }
        }
    }
    None
}

// ─── 用户指定的路径 ───

fn overrides_file(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    Some(dir.join("companion-apps.json"))
}

fn read_overrides(app: &AppHandle) -> serde_json::Map<String, serde_json::Value> {
    let Some(path) = overrides_file(app) else {
        return serde_json::Map::new();
    };
    let Ok(raw) = std::fs::read_to_string(path) else {
        return serde_json::Map::new();
    };
    serde_json::from_str::<serde_json::Value>(&raw)
        .ok()
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

fn write_overrides(app: &AppHandle, map: &serde_json::Map<String, serde_json::Value>) {
    let Some(path) = overrides_file(app) else {
        return;
    };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(text) = serde_json::to_string_pretty(&serde_json::Value::Object(map.clone())) {
        let _ = std::fs::write(path, text);
    }
}

pub fn custom_path(app: &AppHandle, spec: &AppSpec) -> Option<PathBuf> {
    let map = read_overrides(app);
    let value = map.get(spec.id)?.as_str()?.trim().to_string();
    if value.is_empty() {
        return None;
    }
    let path = PathBuf::from(value);
    path.is_file().then_some(path)
}

/// 记下用户指定的入口路径。**只接受文件名匹配的**，避免变成"启动任意程序"的口子。
pub fn set_custom_path(app: &AppHandle, spec: &AppSpec, path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path.trim());
    if !p.is_file() {
        return Err(format!("不是一个文件：{}", p.display()));
    }
    let name = p
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    if name != spec.entry {
        return Err(format!(
            "请选择名为 {} 的文件（当前选的是 {name}）",
            spec.entry
        ));
    }
    let mut map = read_overrides(app);
    map.insert(
        spec.id.to_string(),
        serde_json::Value::String(p.to_string_lossy().to_string()),
    );
    write_overrides(app, &map);
    Ok(p)
}

pub fn clear_custom_path(app: &AppHandle, spec: &AppSpec) {
    let mut map = read_overrides(app);
    map.remove(spec.id);
    write_overrides(app, &map);
}

// ─── 找入口脚本 ───

/// 依次找：用户指定的 → 随包资源 / 仓库副本 / 当前目录
///
/// 同名副本可能同时存在好几份：随包资源里一份、`target/<profile>/` 一份（打包时复制的）、
/// 仓库里一份（开发时改的那份）。这里取**修改时间最新**的一份 —— 否则改完 `bili_dl.py`
/// 直接点「打开下载器」，跑的还是上次构建复制过去的旧副本，看起来就像"改了没用"。
fn find_script(app: &AppHandle, spec: &AppSpec) -> Option<(PathBuf, String)> {
    if let Some(p) = custom_path(app, spec) {
        return Some((p, "custom".to_string()));
    }

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.join(spec.bundled_dir).join(spec.entry));
    }
    // 开发时：可执行文件在 src-tauri/target/<profile>/，往上找仓库根
    if let Ok(exe) = std::env::current_exe() {
        let mut cur = exe.parent().map(Path::to_path_buf);
        for _ in 0..5 {
            let Some(dir) = cur else { break };
            candidates.push(dir.join(spec.bundled_dir).join(spec.entry));
            cur = dir.parent().map(Path::to_path_buf);
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join(spec.bundled_dir).join(spec.entry));
    }

    candidates
        .into_iter()
        .filter(|p| p.is_file())
        .max_by_key(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok())
        .map(|p| (p, "bundled".to_string()))
}

// ─── 对外 ───

pub fn status(app: &AppHandle, spec: &AppSpec) -> AppStatus {
    let script = find_script(app, spec);
    let python = find_python();
    match (&script, &python) {
        (Some((s, source)), Some(p)) => AppStatus {
            available: true,
            script: Some(s.to_string_lossy().to_string()),
            python: Some(p.to_string_lossy().to_string()),
            source: Some(source.clone()),
            message: "已就绪".to_string(),
        },
        (None, _) => AppStatus {
            available: false,
            script: None,
            python: python.map(|p| p.to_string_lossy().to_string()),
            source: None,
            message: format!("没找到 {}（点下面手动指定一次位置即可记住）", spec.entry),
        },
        (Some((s, source)), None) => AppStatus {
            available: false,
            script: Some(s.to_string_lossy().to_string()),
            python: None,
            source: Some(source.clone()),
            message: "找到了程序，但没找到 Python 解释器（需要 Python 3.9+，且自带 tkinter）"
                .to_string(),
        },
    }
}

pub fn launch(app: &AppHandle, spec: &AppSpec) -> Result<String, String> {
    let st = status(app, spec);
    if !st.available {
        return Err(st.message);
    }
    let script = st.script.clone().unwrap_or_default();
    let python = st.python.clone().unwrap_or_default();

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
        app,
        "info",
        &format!(
            "[伴随程序] 已启动 {}（{}）pid={}",
            spec.entry,
            spec.id,
            child.id()
        ),
    );
    Ok(format!(
        "已启动 {}（pid {}）",
        Path::new(&script)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| spec.entry.to_string()),
        child.id()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 只验证"能返回候选而不 panic"；具体命中哪个取决于机器
    #[test]
    fn 找解释器不panic() {
        let _ = find_python();
    }

    #[test]
    fn 入口文件名约定() {
        assert_eq!(NETDISK.entry, "main.py");
        assert_eq!(APIPROBE.entry, "api_probe.py");
        // 两个程序必须落在不同的 id 与目录上，否则会互相覆盖配置
        assert_ne!(NETDISK.id, APIPROBE.id);
        assert_ne!(NETDISK.bundled_dir, APIPROBE.bundled_dir);
    }
}
