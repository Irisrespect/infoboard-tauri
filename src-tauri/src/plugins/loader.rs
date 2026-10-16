/**
 * 外部插件加载器 (Rust 侧)
 *
 * 职责：
 * 1. 扫描 plugins/ 目录
 * 2. 解析每个插件的 manifest.json
 * 3. 返回插件元数据列表给前端
 */

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, Manager};

/// 插件 manifest.json 结构
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PluginManifest {
    /// 插件唯一标识
    pub id: String,

    /// 显示名称
    pub name: String,

    /// 版本号
    pub version: String,

    /// 作者
    #[serde(default)]
    pub author: String,

    /// 插件描述
    #[serde(default)]
    pub description: String,

    /// 所属区域: "info" 或 "tool"
    pub section: String,

    /// 图标 (emoji 或路径)
    pub icon: String,

    /// 入口文件名 (相对插件目录)
    pub entry: String,

    /// 声明的权限列表 (可选)
    #[serde(default)]
    pub permissions: Vec<String>,

    /// Tauri 命令列表 (可选)
    #[serde(default)]
    pub tauri_commands: Vec<String>,
}

/// 外部插件元数据 (返回给前端)
#[derive(Debug, Serialize, Clone)]
pub struct ExternalPluginMeta {
    /// 插件 ID
    pub id: String,

    /// 插件目录路径 (绝对路径)
    pub path: String,

    /// 入口文件路径 (绝对路径)
    #[serde(rename = "entryPath")]
    pub entry_path: String,

    /// manifest 内容
    pub manifest: PluginManifest,

    /// 权限列表
    #[serde(default)]
    pub permissions: Vec<String>,

    /// Tauri 命令列表
    #[serde(rename = "tauriCommands", default)]
    pub tauri_commands: Vec<String>,
}

/// 外部插件目录：`%APPDATA%\com.infoboard.tauri\plugins`
///
/// 不能用相对路径 `plugins`：它相对进程 CWD，dev 下是 src-tauri，
/// 装好的包里根本没有这个目录，扫描恒为空。
pub fn plugins_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join("plugins"))
        .map_err(|e| format!("无法获取应用数据目录: {e}"))
}

/// 解析 manifest.entry 为插件目录内的路径。
/// 拒绝绝对路径和 `..`，防止 manifest 指向插件目录之外的文件。
pub fn resolve_entry(plugin_dir: &Path, entry: &str) -> Result<PathBuf, String> {
    let rel = Path::new(entry);
    if rel.is_absolute() || rel.has_root() {
        return Err(format!("entry 不能是绝对路径: {entry}"));
    }
    for c in rel.components() {
        match c {
            Component::Normal(_) | Component::CurDir => {}
            _ => return Err(format!("entry 不能包含 '..' 或盘符: {entry}")),
        }
    }
    Ok(plugin_dir.join(rel))
}

/// Tauri 命令: 扫描外部插件目录
///
/// 返回所有有效插件的元数据
#[tauri::command]
pub fn scan_external_plugins(app: AppHandle) -> Result<Vec<ExternalPluginMeta>, String> {
    let plugins_dir = plugins_dir(&app)?;

    // 如果目录不存在，创建它
    if !plugins_dir.exists() {
        fs::create_dir_all(&plugins_dir)
            .map_err(|e| format!("创建插件目录失败: {}", e))?;
        println!("[PluginLoader] 创建插件目录: {:?}", plugins_dir);
        return Ok(vec![]);
    }

    println!("[PluginLoader] 扫描插件目录: {:?}", plugins_dir);

    let mut result = vec![];

    // 遍历 plugins/ 下的每个子目录
    for entry in fs::read_dir(&plugins_dir)
        .map_err(|e| format!("读取插件目录失败: {}", e))?
    {
        let entry = entry.map_err(|e| format!("读取条目失败: {}", e))?;
        let plugin_dir = entry.path();

        // 跳过非目录
        if !plugin_dir.is_dir() {
            continue;
        }

        // 查找 manifest.json
        let manifest_path = plugin_dir.join("manifest.json");
        if !manifest_path.exists() {
            println!(
                "[PluginLoader] 跳过 {:?}: 缺少 manifest.json",
                plugin_dir.file_name().unwrap_or_default()
            );
            continue;
        }

        // 解析 manifest.json
        match load_plugin_manifest(&manifest_path) {
            Ok(manifest) => {
                // 构造入口文件绝对路径（拒绝逃出插件目录的 entry）
                let entry_path = match resolve_entry(&plugin_dir, &manifest.entry) {
                    Ok(p) => p,
                    Err(e) => {
                        println!("[PluginLoader] 跳过 {}: {}", manifest.id, e);
                        continue;
                    }
                };

                if !entry_path.exists() {
                    println!(
                        "[PluginLoader] 跳过 {}: 入口文件不存在 {:?}",
                        manifest.id, entry_path
                    );
                    continue;
                }

                let meta = ExternalPluginMeta {
                    id: manifest.id.clone(),
                    path: plugin_dir
                        .to_string_lossy()
                        .to_string(),
                    entry_path: entry_path
                        .to_string_lossy()
                        .to_string(),
                    permissions: manifest.permissions.clone(),
                    tauri_commands: manifest.tauri_commands.clone(),
                    manifest,
                };

                println!("[PluginLoader] 发现插件: {}", meta.id);
                result.push(meta);
            }
            Err(e) => {
                println!(
                    "[PluginLoader] 解析 {:?} 失败: {}",
                    manifest_path, e
                );
            }
        }
    }

    println!("[PluginLoader] 共发现 {} 个插件", result.len());
    Ok(result)
}

/// 加载并解析 manifest.json
fn load_plugin_manifest(path: &PathBuf) -> Result<PluginManifest, String> {
    let content = fs::read_to_string(path)
        .map_err(|e| format!("读取 manifest.json 失败: {}", e))?;

    let manifest: PluginManifest = serde_json::from_str(&content)
        .map_err(|e| format!("解析 manifest.json 失败: {}", e))?;

    // 基本验证
    if manifest.id.is_empty() {
        return Err("manifest.id 不能为空".to_string());
    }

    if manifest.name.is_empty() {
        return Err("manifest.name 不能为空".to_string());
    }

    if manifest.section != "info" && manifest.section != "tool" {
        return Err(format!(
            "manifest.section 必须是 'info' 或 'tool', 当前: {}",
            manifest.section
        ));
    }

    if manifest.entry.is_empty() {
        return Err("manifest.entry 不能为空".to_string());
    }

    Ok(manifest)
}

/// 入口源码大小上限，避免误放超大文件拖垮前端
const MAX_ENTRY_BYTES: u64 = 2 * 1024 * 1024;

/// 按插件 id 读取入口源码。
///
/// 前端不能直接 `import()` 磁盘上的 .tsx（WebView 读不到磁盘文件，也没有编译器），
/// 所以由 Rust 读出源码文本，前端转译后在受控环境里执行。
/// 只接受已扫描到的插件 id，不接受任意路径。
pub fn read_entry_source(plugins_dir: &Path, plugin_id: &str) -> Result<String, String> {
    let plugin_dir = find_plugin_dir(plugins_dir, plugin_id)?;
    let manifest = load_plugin_manifest(&plugin_dir.join("manifest.json"))?;
    let entry = resolve_entry(&plugin_dir, &manifest.entry)?;

    // 真实路径必须仍在插件目录内（挡住符号链接/联接点逃逸）
    let real_dir = plugin_dir
        .canonicalize()
        .map_err(|e| format!("解析插件目录失败: {e}"))?;
    let real_entry = entry
        .canonicalize()
        .map_err(|e| format!("入口文件不存在: {e}"))?;
    if !real_entry.starts_with(&real_dir) {
        return Err("入口文件不在插件目录内".to_string());
    }

    let len = fs::metadata(&real_entry)
        .map_err(|e| format!("读取入口文件信息失败: {e}"))?
        .len();
    if len > MAX_ENTRY_BYTES {
        return Err(format!("入口文件过大 ({len} 字节，上限 {MAX_ENTRY_BYTES})"));
    }
    fs::read_to_string(&real_entry).map_err(|e| format!("读取入口文件失败: {e}"))
}

/// 在插件目录下按 manifest.id 找到对应子目录
fn find_plugin_dir(plugins_dir: &Path, plugin_id: &str) -> Result<PathBuf, String> {
    let rd = fs::read_dir(plugins_dir).map_err(|e| format!("读取插件目录失败: {e}"))?;
    for entry in rd.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let mp = dir.join("manifest.json");
        if !mp.exists() {
            continue;
        }
        if let Ok(m) = load_plugin_manifest(&mp) {
            if m.id == plugin_id {
                return Ok(dir);
            }
        }
    }
    Err(format!("未找到插件: {plugin_id}"))
}

#[tauri::command]
pub fn read_external_plugin_source(app: AppHandle, plugin_id: String) -> Result<String, String> {
    read_entry_source(&plugins_dir(&app)?, &plugin_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("infoboard-loader-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn write_plugin(root: &Path, dir: &str, id: &str, entry: &str, src: &str) -> PathBuf {
        let d = root.join(dir);
        fs::create_dir_all(&d).unwrap();
        fs::write(
            d.join("manifest.json"),
            format!(
                r#"{{"id":"{id}","name":"n","version":"1.0.0","section":"info","icon":"x","entry":"{entry}"}}"#
            ),
        )
        .unwrap();
        fs::write(d.join(entry), src).unwrap();
        d
    }

    #[test]
    fn resolve_entry_accepts_plain_and_nested() {
        let base = Path::new("C:\\p\\a");
        assert!(resolve_entry(base, "index.tsx").is_ok());
        assert!(resolve_entry(base, "src/index.tsx").is_ok());
        assert!(resolve_entry(base, "./index.tsx").is_ok());
    }

    #[test]
    fn resolve_entry_rejects_escape() {
        let base = Path::new("C:\\p\\a");
        assert!(resolve_entry(base, "../evil.tsx").is_err());
        assert!(resolve_entry(base, "a/../../evil.tsx").is_err());
        assert!(resolve_entry(base, "C:\\Windows\\system.ini").is_err());
        assert!(resolve_entry(base, "/etc/passwd").is_err());
    }

    #[test]
    fn read_entry_source_returns_source_by_id() {
        let root = temp_dir("read");
        write_plugin(&root, "dir-a", "plug-a", "index.tsx", "export default 1");
        let src = read_entry_source(&root, "plug-a").unwrap();
        assert_eq!(src, "export default 1");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn read_entry_source_unknown_id_fails() {
        let root = temp_dir("unknown");
        write_plugin(&root, "dir-a", "plug-a", "index.tsx", "x");
        assert!(read_entry_source(&root, "nope").is_err());
        // 不接受路径形式的 id
        assert!(read_entry_source(&root, "../dir-a").is_err());
        let _ = fs::remove_dir_all(&root);
    }

    /// 回归：manifest.entry 指向插件目录外的文件时必须被拒绝
    #[test]
    fn read_entry_source_rejects_entry_outside_plugin_dir() {
        let root = temp_dir("escape");
        fs::write(root.join("secret.txt"), "TOP-SECRET").unwrap();
        let d = root.join("dir-a");
        fs::create_dir_all(&d).unwrap();
        fs::write(
            d.join("manifest.json"),
            r#"{"id":"plug-a","name":"n","version":"1","section":"info","icon":"x","entry":"../secret.txt"}"#,
        )
        .unwrap();
        let err = read_entry_source(&root, "plug-a").unwrap_err();
        assert!(!err.contains("TOP-SECRET"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn read_entry_source_rejects_oversized() {
        let root = temp_dir("big");
        let d = write_plugin(&root, "dir-a", "plug-a", "index.tsx", "");
        let f = fs::File::create(d.join("index.tsx")).unwrap();
        f.set_len(MAX_ENTRY_BYTES + 1).unwrap();
        drop(f);
        assert!(read_entry_source(&root, "plug-a").unwrap_err().contains("过大"));
        let _ = fs::remove_dir_all(&root);
    }
}
