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
use tauri::{AppHandle, Emitter, Manager};

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
    /// 入口来自哪里：`plugin`（插件包自带）/ `bundled`（随安装包）/ `custom`（用户指定）
    pub source: Option<String>,
    /// 实际要跑的那份程序的版本（读它旁边的 `VERSION` 文件）
    pub version: Option<String>,
    /// 插件 manifest 声明的版本（`companion.version`）—— 两者不一致就是"插件更新了、
    /// 程序没更新"或反过来，必须让用户看见，而不是静默跑旧代码
    pub expected: Option<String>,
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

// ─── 插件包自带的程序（`companion` 声明） ───

/// 插件 manifest 里的 `companion` 段：启动器类插件可以把**伴随程序一起打进
/// `.ibplugin`**。
///
/// 为什么需要它：网盘下载 / API 测活 / B 站下载这三个插件的"本体"是独立程序，
/// 以前程序只能随安装包发 —— 于是改一行 Python 也要重装整个应用，
/// `.ibplugin` 这个"热更新"通道对它们形同虚设（插件版本号只能跟着程序版本空转）。
/// 现在插件可以自带一份，宿主优先用它；安装包里那份退化成"没装插件时的兜底"。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompanionDecl {
    /// 插件目录下的子目录（约定叫 `app`）
    pub dir: String,
    /// 子目录里的入口文件（`main.py` / `my_tool.exe`）
    pub entry: String,
    /// 内置程序的版本；必须与程序目录里的 `VERSION` 一致（打包脚本会强制校验）
    pub version: String,
    /// 怎么跑：`python`（默认，脚本）或 `exe`（插件自带的可执行文件，不需要 Python）
    pub kind: String,
}

/// 解析 manifest 里的 `companion` 段。纯函数，方便测试。
///
/// 拒绝绝对路径与 `..`：插件目录里的声明不能把入口指到插件外面去
/// （解压侧（`pack.rs`）已经在防 zip slip，这里是同一套约束的第二道）。
pub fn parse_companion(manifest_text: &str) -> Option<CompanionDecl> {
    let value: serde_json::Value = serde_json::from_str(manifest_text).ok()?;
    let node = value.get("companion")?;
    let dir = node.get("dir")?.as_str()?.trim().to_string();
    let entry = node.get("entry")?.as_str()?.trim().to_string();
    let version = match node.get("version") {
        Some(serde_json::Value::String(s)) => s.trim().to_string(),
        Some(other) => other.to_string(),
        None => return None,
    };
    let kind = match node.get("kind") {
        None => "python".to_string(),
        Some(serde_json::Value::String(s)) => match s.trim() {
            "python" | "exe" => s.trim().to_string(),
            _ => return None,       // 认不出的运行方式一律拒绝，别猜
        },
        Some(_) => return None,
    };
    if !is_safe_rel(&dir) || !is_safe_rel(&entry) || version.is_empty() {
        return None;
    }
    Some(CompanionDecl {
        dir,
        entry,
        version,
        kind,
    })
}

/// 插件内相对路径的安全检查：不能空、不能绝对、不能有 `..`、不能带盘符
fn is_safe_rel(rel: &str) -> bool {
    !rel.is_empty()
        && !rel.starts_with('/')
        && !rel.starts_with('\\')
        && !rel.contains("..")
        && !rel.contains(':')
}

/// 读插件目录里的 `companion` 声明（没装插件 / 老插件都会返回 None）
fn read_plugin_companion(app: &AppHandle, id: &str) -> Option<CompanionDecl> {
    let dir = crate::plugins::loader::plugins_dir(app).ok()?.join(id);
    let text = std::fs::read_to_string(dir.join("manifest.json")).ok()?;
    parse_companion(&text)
}

/// 插件自带的那份入口脚本（文件不存在就不算）
fn plugin_script(app: &AppHandle, spec: &AppSpec) -> Option<(PathBuf, CompanionDecl)> {
    let decl = read_plugin_companion(app, spec.id)?;
    let root = crate::plugins::loader::plugins_dir(app).ok()?;
    let path = root.join(spec.id).join(&decl.dir).join(&decl.entry);
    if path.is_file() {
        Some((path, decl))
    } else {
        None
    }
}

/// 读程序旁边的 `VERSION`（纯文本一行）。读不到 / 不像版本号就返回 None。
pub fn read_version(script: &Path) -> Option<String> {
    let text = std::fs::read_to_string(script.parent()?.join("VERSION")).ok()?;
    let version = text.trim().to_string();
    if version.is_empty() || version.len() > 32 {
        None
    } else {
        Some(version)
    }
}

/// 插件自带程序的完整路径：**只由宿主拼**，插件没有机会传一个自己的路径进来
/// （这是 P3 和"借 `companion_set_path` 指到任意 main.py"的关键区别）。
pub fn companion_path(plugins_root: &Path, id: &str, decl: &CompanionDecl) -> PathBuf {
    plugins_root.join(id).join(&decl.dir).join(&decl.entry)
}

/// 列出"带 companion 声明的插件"（给 `companion_list` 用）
pub fn plugin_companions(app: &AppHandle) -> Vec<(String, CompanionDecl)> {
    let Ok(root) = crate::plugins::loader::plugins_dir(app) else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(&root) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let Some(name) = dir.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if name.starts_with('.') {
            continue;                       // .installing-* / .uninstalled-* 等临时目录
        }
        let Ok(text) = std::fs::read_to_string(dir.join("manifest.json")) else {
            continue;
        };
        let Some(decl) = parse_companion(&text) else {
            continue;
        };
        let id = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|v| v.get("id").and_then(|i| i.as_str()).map(str::to_string))
            .unwrap_or_else(|| name.to_string());
        out.push((id, decl));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

// ─── 找入口脚本 ───

/// 依次找：用户指定的 → **插件包自带** → 随包资源 / 仓库副本 / 当前目录（取最新）
///
/// 同名副本可能同时存在好几份：插件包里一份（可热更新）、随包资源里一份、
/// `target/<profile>/` 一份（打包时复制的）、仓库里一份（开发时改的那份）。
/// 除用户指定外，全部丢进"取修改时间最新"的比较里 —— 这样两种场景都对：
/// 安装版里插件自带的那份更新（除非刚重装过应用），开发时仓库里那份更新。
fn find_script(app: &AppHandle, spec: &AppSpec) -> Option<(PathBuf, String)> {
    if let Some(p) = custom_path(app, spec) {
        return Some((p, "custom".to_string()));
    }

    let mut candidates: Vec<(PathBuf, &'static str)> = Vec::new();
    if let Some((path, _decl)) = plugin_script(app, spec) {
        candidates.push((path, "plugin"));
    }
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push((dir.join(spec.bundled_dir).join(spec.entry), "bundled"));
    }
    // 开发时：可执行文件在 src-tauri/target/<profile>/，往上找仓库根
    if let Ok(exe) = std::env::current_exe() {
        let mut cur = exe.parent().map(Path::to_path_buf);
        for _ in 0..5 {
            let Some(dir) = cur else { break };
            candidates.push((dir.join(spec.bundled_dir).join(spec.entry), "bundled"));
            cur = dir.parent().map(Path::to_path_buf);
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push((cwd.join(spec.bundled_dir).join(spec.entry), "bundled"));
    }

    candidates
        .into_iter()
        .filter(|(p, _)| p.is_file())
        .max_by_key(|(p, _)| std::fs::metadata(p).and_then(|m| m.modified()).ok())
        .map(|(p, source)| (p, source.to_string()))
}

// ─── 对外 ───

/// 版本漂移说明（有就返回一句人话）：插件声明的版本 ≠ 实际要跑的版本
fn drift_note(actual: Option<&String>, expected: Option<&String>) -> Option<String> {
    match (actual, expected) {
        (Some(have), Some(want)) if have != want => Some(format!(
            "插件包声明 {want}，实际运行 {have}（重装插件包或应用安装包，任一方对齐即可）"
        )),
        _ => None,
    }
}

// ─── 按 id 取：注册表优先，其次"插件自带的程序" ───

/// 插件自带程序的可用性（不看注册表）
fn plugin_status(app: &AppHandle, id: &str, decl: &CompanionDecl) -> AppStatus {
    let root = crate::plugins::loader::plugins_dir(app).ok();
    let script = root.as_ref().map(|r| companion_path(r, id, decl));
    let exists = script.as_ref().map(|p| p.is_file()).unwrap_or(false);
    let python = find_python();
    let version = if exists {
        script.as_ref().and_then(|p| read_version(p))
    } else {
        None
    };
    let needs_python = decl.kind != "exe";
    let available = exists && (!needs_python || python.is_some());

    let message = if !exists {
        format!(
            "插件 {id} 声明的程序没装好（{}/{}），重装一次插件包即可",
            decl.dir, decl.entry
        )
    } else if needs_python && python.is_none() {
        "找到了程序，但没找到 Python 解释器（需要 Python 3.9+）".to_string()
    } else {
        "已就绪（插件自带）".to_string()
    };

    let mut st = AppStatus {
        available,
        script: script.map(|p| p.to_string_lossy().to_string()),
        python: python.map(|p| p.to_string_lossy().to_string()),
        source: Some("plugin".to_string()),
        version: version.clone(),
        expected: Some(decl.version.clone()),
        message,
    };
    if let Some(note) = drift_note(version.as_ref(), Some(&decl.version)) {
        st.message = format!("{} —— ⚠️ 版本不一致：{note}", st.message);
    }
    st
}

/// 任何 id 的状态：先查注册表（netdisk / apiprobe / bilidl），再查插件自带的 `companion`。
///
/// 这一条就是 P3 的意义：新插件**不需要**宿主认识它，只要包里带了程序 + 声明，
/// 就能被这组通用命令拉起 —— 也就是"只发一个 .ibplugin 就能加功能"。
pub fn status_by_id(app: &AppHandle, id: &str) -> Result<AppStatus, String> {
    if let Some(spec) = by_id(id) {
        return Ok(status(app, spec));
    }
    let decl = read_plugin_companion(app, id).ok_or_else(|| unknown_id_message(app, id))?;
    Ok(plugin_status(app, id, &decl))
}

/// 启动任何 id（注册表或插件自带）
pub fn launch_by_id(app: &AppHandle, id: &str) -> Result<String, String> {
    if let Some(spec) = by_id(id) {
        return launch(app, spec);
    }
    let decl = read_plugin_companion(app, id).ok_or_else(|| unknown_id_message(app, id))?;
    let st = plugin_status(app, id, &decl);
    if !st.available {
        return Err(st.message);
    }
    let script = PathBuf::from(st.script.clone().unwrap_or_default());

    // python 脚本 vs 自带 exe：exe 不需要解释器，直接执行（cwd 由 spawn_program 设）
    let (program, args) = if decl.kind == "exe" {
        (script.to_string_lossy().to_string(), Vec::new())
    } else {
        (
            st.python.clone().unwrap_or_default(),
            vec![script.to_string_lossy().to_string()],
        )
    };
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let pid = spawn_program(
        app,
        id,
        &script,
        &program,
        &arg_refs,
        st.version.as_deref(),
        st.expected.as_deref(),
    )?;
    let label = script
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| decl.entry.clone());
    Ok(format!("已启动 {label}（pid {pid}）"))
}

/// 报错时把"能用的 id"列全：注册表 + 已装插件里声明了 companion 的
fn unknown_id_message(app: &AppHandle, id: &str) -> String {
    let mut known: Vec<String> = ALL.iter().map(|s| s.id.to_string()).collect();
    for (pid, _decl) in plugin_companions(app) {
        if !known.contains(&pid) {
            known.push(pid);
        }
    }
    format!(
        "未知的伴随程序 \"{id}\"。可用: {}（插件需要在 manifest.json 里声明 companion 才会出现在这里）",
        known.join(", ")
    )
}

pub fn status(app: &AppHandle, spec: &AppSpec) -> AppStatus {
    let script = find_script(app, spec);
    let python = find_python();
    let version = script.as_ref().and_then(|(s, _src)| read_version(s));
    let expected = read_plugin_companion(app, spec.id).map(|decl| decl.version);

    let mut st = match (&script, &python) {
        (Some((s, source)), Some(p)) => AppStatus {
            available: true,
            script: Some(s.to_string_lossy().to_string()),
            python: Some(p.to_string_lossy().to_string()),
            source: Some(source.clone()),
            version: version.clone(),
            expected: expected.clone(),
            message: "已就绪".to_string(),
        },
        (None, _) => AppStatus {
            available: false,
            script: None,
            python: python.map(|p| p.to_string_lossy().to_string()),
            source: None,
            version: None,
            expected: expected.clone(),
            message: format!("没找到 {}（点下面手动指定一次位置即可记住）", spec.entry),
        },
        (Some((s, source)), None) => AppStatus {
            available: false,
            script: Some(s.to_string_lossy().to_string()),
            python: None,
            source: Some(source.clone()),
            version: version.clone(),
            expected: expected.clone(),
            message: "找到了程序，但没找到 Python 解释器（需要 Python 3.9+，且自带 tkinter）"
                .to_string(),
        },
    };

    // 版本漂移要写进 message：插件面板会原样显示，用户一眼能看到
    // "插件是新的、程序是旧的（或反过来）"，而不是等某个功能出诡异错误。
    if let Some(note) = drift_note(version.as_ref(), expected.as_ref()) {
        st.message = format!("{} —— ⚠️ 版本不一致：{note}", st.message);
    }
    st
}

pub fn launch(app: &AppHandle, spec: &AppSpec) -> Result<String, String> {
    let st = status(app, spec);
    if !st.available {
        return Err(st.message);
    }
    let script = st.script.clone().unwrap_or_default();
    let python = st.python.clone().unwrap_or_default();
    let pid = spawn_program(
        app,
        spec.id,
        Path::new(&script),
        &python,
        &[script.as_str()],
        st.version.as_deref(),
        st.expected.as_deref(),
    )?;
    Ok(format!(
        "已启动 {}（pid {pid}）",
        Path::new(&script)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| spec.entry.to_string())
    ))
}

/// 真正把进程拉起来（注册表路径与插件自带程序共用）。
///
/// `program` 是要执行的程序（python 解释器或插件自带的 exe），`args` 是附加参数，
/// 工作目录统一设成入口所在目录 —— 程序自己的相对路径才找得到。
fn spawn_program(
    app: &AppHandle,
    id: &str,
    script: &Path,
    program: &str,
    args: &[&str],
    version: Option<&str>,
    expected: Option<&str>,
) -> Result<u32, String> {
    let mut cmd = Command::new(program);
    cmd.args(args);
    if let Some(dir) = script.parent() {
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
        .map_err(|e| format!("启动失败（{program}）：{e}"))?;

    crate::core::app_log::emit(
        app,
        "info",
        &format!(
            "[伴随程序] 已启动 {}（{}）pid={} 版本={}",
            script
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default(),
            id,
            child.id(),
            version.unwrap_or("?")
        ),
    );

    // 版本漂移：启动这一刻是用户唯一一定会看的地方，所以除了日志再弹一条 toast。
    // 面板（`plugins/netdisk/index.tsx`）在宿主新版本里根本不渲染，只靠状态栏没人看得见。
    let have = version.map(str::to_string);
    let want = expected.map(str::to_string);
    if let Some(note) = drift_note(have.as_ref(), want.as_ref()) {
        let message = format!("{id} 版本不一致：{note}");
        crate::core::app_log::emit(app, "warn", &format!("[伴随程序] {message}"));
        let _ = app.emit(
            "toast_show",
            serde_json::json!({ "message": message, "level": "warn", "duration": 8000 }),
        );
    }

    Ok(child.id())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

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

    #[test]
    fn 解析插件里的_companion_声明() {
        let text = r#"{
            "id": "netdisk", "name": "网盘下载", "version": "2.1.0",
            "section": "tool", "icon": "cloud-download", "entry": "index.tsx",
            "companion": { "dir": "app", "entry": "main.py", "version": "2.1.0" }
        }"#;
        let decl = parse_companion(text).expect("应该能解析");
        assert_eq!(decl.dir, "app");
        assert_eq!(decl.entry, "main.py");
        assert_eq!(decl.version, "2.1.0");

        // 没有 companion 段（纯前端插件、老插件）→ None，不是错误
        assert!(parse_companion(r#"{"id":"translate","version":"2.2.0"}"#).is_none());
        // 不是 JSON → None
        assert!(parse_companion("not json").is_none());
    }

    #[test]
    fn 拒绝越界的_companion_声明() {
        let bad = [
            // dir 想跳出插件目录
            r#"{"companion":{"dir":"../..","entry":"main.py","version":"1.0.0"}}"#,
            // entry 绝对路径
            r#"{"companion":{"dir":"app","entry":"/etc/passwd","version":"1.0.0"}}"#,
            // 盘符
            r#"{"companion":{"dir":"app","entry":"C:\\x\\main.py","version":"1.0.0"}}"#,
            // 缺版本号
            r#"{"companion":{"dir":"app","entry":"main.py"}}"#,
            // 空 dir
            r#"{"companion":{"dir":"","entry":"main.py","version":"1.0.0"}}"#,
            // 认不出的运行方式
            r#"{"companion":{"dir":"app","entry":"main.py","version":"1.0.0","kind":"powershell"}}"#,
        ];
        for text in bad {
            assert!(parse_companion(text).is_none(), "不该接受：{text}");
        }
    }

    #[test]
    fn companion_的运行方式() {
        // 不写 kind → 默认 python
        let decl = parse_companion(r#"{"companion":{"dir":"app","entry":"main.py","version":"1.0.0"}}"#)
            .expect("应该能解析");
        assert_eq!(decl.kind, "python");

        // 自带 exe：不需要 Python
        let decl = parse_companion(
            r#"{"companion":{"dir":"app","entry":"tool.exe","version":"1.0.0","kind":"exe"}}"#,
        )
        .expect("应该能解析");
        assert_eq!(decl.kind, "exe");
        assert_eq!(decl.entry, "tool.exe");
    }

    #[test]
    fn 插件自带程序的路径只由宿主拼() {
        let decl = CompanionDecl {
            dir: "app".to_string(),
            entry: "main.py".to_string(),
            version: "1.0.0".to_string(),
            kind: "python".to_string(),
        };
        let root = Path::new("C:/app-data/plugins");
        let path = companion_path(root, "my-tool", &decl);
        assert_eq!(path, Path::new("C:/app-data/plugins/my-tool/app/main.py"));
        // id 换了，路径跟着换 —— 这是"插件只能启动自己包里那份"的基础
        assert_ne!(
            companion_path(root, "other", &decl),
            companion_path(root, "my-tool", &decl)
        );
    }

    #[test]
    fn 读程序目录里的版本文件() {
        let root = std::env::temp_dir().join(format!("ib-ver-{}", std::process::id()));
        let app_dir = root.join("netdisk-app");
        fs::create_dir_all(&app_dir).unwrap();
        let script = app_dir.join("main.py");
        fs::write(&script, "print('x')").unwrap();

        // 没有 VERSION → None（老副本，不该崩）
        assert_eq!(read_version(&script), None);

        fs::write(app_dir.join("VERSION"), "2.1.0\n").unwrap();
        assert_eq!(read_version(&script).as_deref(), Some("2.1.0"));

        // 空白文件 → None
        fs::write(app_dir.join("VERSION"), "   \n").unwrap();
        assert_eq!(read_version(&script), None);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn 版本漂移只在真的不一致时才提示() {
        let have = Some("2.0.0".to_string());
        let want = Some("2.1.0".to_string());
        assert!(drift_note(have.as_ref(), want.as_ref()).is_some());

        let same = Some("2.1.0".to_string());
        assert!(drift_note(same.as_ref(), same.as_ref()).is_none());

        // 任一方不知道（老插件没声明 / 老程序没 VERSION）→ 不打扰用户
        assert!(drift_note(None, want.as_ref()).is_none());
        assert!(drift_note(have.as_ref(), None).is_none());
    }
}
