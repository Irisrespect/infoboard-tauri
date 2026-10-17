//! 插件包（`.ibplugin`）的导入与卸载
//!
//! `.ibplugin` 就是一个 zip，根目录含 `manifest.json` 与入口文件（入口名由
//! manifest 的 `entry` 指定）。使用者把包拖进「设置 → 插件管理」即可安装，
//! 不必手动找 `%APPDATA%` 目录。
//!
//! 安全要点（包内容完全由第三方提供，按不可信输入处理）：
//! 1. 逐条目走 `enclosed_name()`，拒绝 `..`、绝对路径、盘符（zip slip）
//! 2. 限制条目数与解压总字节数，避免 zip 炸弹
//! 3. 全量解压到**临时目录**并校验 manifest，最后才原子改名进插件目录 ——
//!    校验失败时插件目录里不留任何半成品
//! 4. `manifest.id` 必须匹配 `[A-Za-z0-9_-]{1,64}`：它同时是目录名，
//!    不校验就等于允许 `..\..\` 这类目录逃逸

use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

use super::loader::{load_plugin_manifest, plugins_dir};

/// 插件包扩展名
pub const PACKAGE_EXT: &str = "ibplugin";

/// 包内条目数上限
const MAX_ENTRIES: usize = 64;
/// 解压后总字节上限（单文件入口上限 2 MB，留足余量）
const MAX_TOTAL_BYTES: u64 = 8 * 1024 * 1024;
/// 包文件本身的上限
const MAX_PACKAGE_BYTES: u64 = 16 * 1024 * 1024;
/// 插件 id 允许的字符（同时用作目录名）
const ID_MAX_LEN: usize = 64;

/// 已安装的外部插件（返回给前端的元数据）
#[derive(Debug, Serialize, Clone)]
pub struct InstalledPlugin {
    /// manifest.id
    pub id: String,
    pub name: String,
    pub version: String,
    pub author: String,
    pub description: String,
    pub section: String,
    pub icon: String,
    /// 插件目录名（用户手动放进来的目录可能与 id 不同）
    #[serde(rename = "dirName")]
    pub dir_name: String,
    /// 是否为手动放置（非本功能安装）
    pub manual: bool,
}

/// 卸载结果：插件已从磁盘移除，但它的界面组件还在运行
#[derive(Debug, Serialize, Clone)]
pub struct UninstallResult {
    pub id: String,
    /// 需要重启应用才能彻底清掉（文件被加载中的组件占用）
    #[serde(rename = "needsRestart")]
    pub needs_restart: bool,
}

/// 校验插件 id：既作 manifest 字段，又作目录名
pub fn validate_plugin_id(id: &str) -> Result<(), String> {
    if id.is_empty() {
        return Err("manifest.id 不能为空".into());
    }
    if id.len() > ID_MAX_LEN {
        return Err(format!("manifest.id 过长（上限 {ID_MAX_LEN} 字符）"));
    }
    // 只允许 ASCII 字母数字、下划线、连字符、点（点不允许出现在开头结尾）
    let ok = id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
        && !id.starts_with('.')
        && !id.ends_with('.');
    if !ok {
        return Err(format!(
            "manifest.id 含非法字符: {id}（只允许字母、数字、下划线、连字符、点，且不能以点开头/结尾）"
        ));
    }
    // 显式再挡一次路径语义（`.` / `..` 这类整体值）
    if id == "." || id == ".." || id.contains("..") {
        return Err(format!("manifest.id 不能是路径片段: {id}"));
    }
    Ok(())
}

/// 从包里读 `manifest.json` 的原始文本（供预览/校验用，不解压其它文件）
pub fn read_manifest_from_package(package: &Path) -> Result<String, String> {
    let file = fs::File::open(package).map_err(|e| format!("打开插件包失败: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("不是有效的插件包（zip）: {e}"))?;

    let mut entry = archive
        .by_name("manifest.json")
        .map_err(|_| "插件包根目录缺少 manifest.json".to_string())?;
    if entry.size() > 64 * 1024 {
        return Err("manifest.json 过大".into());
    }
    let mut text = String::new();
    io::Read::read_to_string(&mut entry, &mut text)
        .map_err(|e| format!("读取 manifest.json 失败: {e}"))?;
    Ok(text)
}

/// 解压插件包到 `target_dir`（该目录必须不存在或为空）
fn extract_package(package: &Path, target_dir: &Path) -> Result<(), String> {
    let file = fs::File::open(package).map_err(|e| format!("打开插件包失败: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("不是有效的插件包（zip）: {e}"))?;

    if archive.len() > MAX_ENTRIES {
        return Err(format!(
            "插件包条目过多（{} 个，上限 {MAX_ENTRIES}）",
            archive.len()
        ));
    }

    let mut total: u64 = 0;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("读取插件包第 {i} 个条目失败: {e}"))?;

        // 关键：拒绝 .. / 绝对路径 / 盘符（zip slip）
        let rel = entry
            .enclosed_name()
            .ok_or_else(|| format!("插件包含非法路径: {}", entry.name()))?
            .to_path_buf();

        total = total.saturating_add(entry.size());
        if total > MAX_TOTAL_BYTES {
            return Err(format!(
                "插件包解压后过大（超过 {} MB）",
                MAX_TOTAL_BYTES / 1024 / 1024
            ));
        }

        let out_path = target_dir.join(&rel);

        // enclosed_name 已挡住逃逸，这里再断言一次（纵深防御）
        if !out_path.starts_with(target_dir) {
            return Err(format!("插件包含非法路径: {}", entry.name()));
        }

        if entry.is_dir() {
            fs::create_dir_all(&out_path).map_err(|e| format!("创建目录失败: {e}"))?;
            continue;
        }

        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
        }
        let mut out =
            fs::File::create(&out_path).map_err(|e| format!("写入 {} 失败: {e}", out_path.display()))?;
        io::copy(&mut entry, &mut out).map_err(|e| format!("解压失败: {e}"))?;
    }

    Ok(())
}

/// 删除目录，用于清理临时目录
fn remove_dir_quietly(dir: &Path) {
    let _ = fs::remove_dir_all(dir);
}

/// 在插件目录下找一个未被占用的临时目录名
fn unique_temp_dir(plugins_dir: &Path, id: &str) -> PathBuf {
    for n in 0..1000u32 {
        let candidate = plugins_dir.join(format!(".installing-{id}-{n}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    // 极端情况下退化成随机名（不会真正走到）
    plugins_dir.join(format!(".installing-{id}-{}", std::process::id()))
}

/// 取一个"不存在的路径"用作改名中转（改名目标必须不存在）
fn unique_backup_dir(plugins_dir: &Path, id: &str) -> PathBuf {
    for n in 0..1000u32 {
        let candidate = plugins_dir.join(format!(".replacing-{id}-{n}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    plugins_dir.join(format!(".replacing-{id}-{}", std::process::id()))
}

/// 安装插件包。同 id 已存在时**覆盖安装**（等于升级）。
///
/// 流程：解压到临时目录 → 校验 manifest → 原子改名进插件目录。
/// 任何一步失败都会清掉临时目录，插件目录保持原样。
pub fn install_plugin_package(plugins_dir: &Path, package: &Path) -> Result<String, String> {
    if !package.is_file() {
        return Err(format!("插件包不存在: {}", package.display()));
    }
    // 扩展名不是硬性要求（允许用户把 .ibplugin 改名后仍能装），但明显不对时给个清晰提示
    if let Some(ext) = package.extension().and_then(|e| e.to_str()) {
        if !ext.eq_ignore_ascii_case(PACKAGE_EXT) {
            println!("[PluginPack] 提示：插件包扩展名是 .{ext}，预期 .{PACKAGE_EXT}");
        }
    }
    let size = fs::metadata(package)
        .map_err(|e| format!("读取插件包信息失败: {e}"))?
        .len();
    if size > MAX_PACKAGE_BYTES {
        return Err(format!(
            "插件包过大（{} MB，上限 {} MB）",
            size / 1024 / 1024,
            MAX_PACKAGE_BYTES / 1024 / 1024
        ));
    }

    // manifest.json 必须存在且合法 —— 先只读它，避免把垃圾解压出来
    let manifest_text = read_manifest_from_package(package)?;

    fs::create_dir_all(plugins_dir).map_err(|e| format!("创建插件目录失败: {e}"))?;

    // 用 manifest 里的 id 作为目录名，所以先做静态校验
    let raw_id = extract_raw_id(&manifest_text)?;
    validate_plugin_id(&raw_id)?;

    let temp_dir = unique_temp_dir(plugins_dir, &raw_id);
    remove_dir_quietly(&temp_dir);

    let result = (|| -> Result<String, String> {
        fs::create_dir_all(&temp_dir).map_err(|e| format!("创建临时目录失败: {e}"))?;
        extract_package(package, &temp_dir)?;

        // 走和扫描时同一套解析/校验：section 合法、entry 非空、entry 不逃逸
        let manifest = load_plugin_manifest(&temp_dir.join("manifest.json"))?;
        validate_plugin_id(&manifest.id)?;

        // id 要与目录名一致（我们按 id 建目录）
        if manifest.id != raw_id {
            return Err(format!(
                "manifest.json 的 id 不一致（读到 {} 和 {}）",
                raw_id, manifest.id
            ));
        }

        let entry = super::loader::resolve_entry(&temp_dir, &manifest.entry)?;
        if !entry.is_file() {
            return Err(format!("入口文件不存在: {}", manifest.entry));
        }

        // 搬到最终位置：已存在则先挪走再删（Windows 上不能直接覆盖非空目录）
        let dest = plugins_dir.join(&manifest.id);
        if dest.exists() {
            let backup = unique_backup_dir(plugins_dir, &manifest.id);
            fs::rename(&dest, &backup).map_err(|e| {
                format!("移动旧版本失败（可能有插件文件被占用，请重启应用后重试）: {e}")
            })?;
            match fs::rename(&temp_dir, &dest) {
                Ok(()) => remove_dir_quietly(&backup),
                Err(e) => {
                    // 回滚：把旧版本挪回来
                    let _ = fs::rename(&backup, &dest);
                    return Err(format!("安装失败（已回滚到旧版本）: {e}"));
                }
            }
        } else {
            fs::rename(&temp_dir, &dest).map_err(|e| format!("安装失败: {e}"))?;
        }

        Ok(manifest.id)
    })();

    remove_dir_quietly(&temp_dir);
    result
}

/// 从 manifest 文本里只取 id（允许其它字段暂时不合法，先拿 id 建目录）
fn extract_raw_id(manifest_text: &str) -> Result<String, String> {
    #[derive(Deserialize)]
    struct OnlyId {
        id: String,
    }
    let v: OnlyId =
        serde_json::from_str(manifest_text).map_err(|e| format!("manifest.json 解析失败: {e}"))?;
    Ok(v.id)
}

/// 列出插件目录下所有已安装插件（含手动放置的）
///
/// 直接读磁盘而不是问注册表：插件可能因为转译失败没进注册表，但用户仍需要看到它并卸载。
pub fn list_plugins(plugins_dir: &Path) -> Vec<InstalledPlugin> {
    let mut out = Vec::new();
    let Ok(rd) = fs::read_dir(plugins_dir) else {
        return out;
    };

    for entry in rd.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let dir_name = match dir.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        // 跳过我们自己的临时目录
        if dir_name.starts_with('.') {
            continue;
        }

        let manifest_path = dir.join("manifest.json");
        if !manifest_path.exists() {
            continue;
        }

        // 用与扫描同一套校验；不合法就跳过（与 scan 行为一致）
        match load_plugin_manifest(&manifest_path) {
            Ok(m) => out.push(InstalledPlugin {
                manual: dir_name != m.id,
                id: m.id,
                name: m.name,
                version: m.version,
                author: m.author,
                description: m.description,
                section: m.section,
                icon: m.icon,
                dir_name,
            }),
            Err(e) => {
                println!("[PluginPack] 跳过 {dir_name}: {e}");
            }
        }
    }

    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

/// 按插件 id 找到磁盘上的目录（目录名可能不等于 id，需扫 manifest）
pub fn find_plugin_dir(plugins_dir: &Path, plugin_id: &str) -> Result<PathBuf, String> {
    validate_plugin_id(plugin_id)?;
    let rd = fs::read_dir(plugins_dir).map_err(|e| format!("读取插件目录失败: {e}"))?;

    for entry in rd.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        if dir
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with('.'))
        {
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

/// 把插件目录挪到回收目录（先改名，避免被加载中的组件占用而删不掉）
pub fn take_plugin_dir(plugins_dir: &Path, plugin_id: &str) -> Result<PathBuf, String> {
    let dir = find_plugin_dir(plugins_dir, plugin_id)?;
    let trash = plugins_dir.join(format!(".uninstalled-{plugin_id}-{}", std::process::id()));

    fs::rename(&dir, &trash).map_err(|e| {
        format!("卸载失败（可能有插件文件被占用，请重启应用后重试）: {e}")
    })?;

    Ok(trash)
}

// ─── Tauri 命令 ───

/// 安装插件包（来自拖拽或文件选择器）
#[tauri::command]
pub fn install_plugin_package_cmd(
    app: AppHandle,
    package_path: String,
) -> Result<String, String> {
    let dir = plugins_dir(&app)?;
    let id = install_plugin_package(&dir, Path::new(&package_path))?;
    crate::core::app_log::emit(&app, "info", &format!("[插件] 已安装: {id}"));
    Ok(id)
}

/// 列出插件目录下已安装的外部插件
#[tauri::command]
pub fn list_installed_plugins(app: AppHandle) -> Result<Vec<InstalledPlugin>, String> {
    Ok(list_plugins(&plugins_dir(&app)?))
}

/// 卸载插件：删除磁盘文件。
///
/// 注意这是**第一步**：此时插件组件可能仍被前台渲染持有（Windows 上文件被占用），
/// 所以先把目录改名挪走；前端拿到结果后应立刻重新加载插件系统，
/// 待组件卸载再调用 `purge_uninstalled_plugin` 真正删掉。
#[tauri::command]
pub fn uninstall_plugin(app: AppHandle, plugin_id: String) -> Result<UninstallResult, String> {
    let dir = plugins_dir(&app)?;
    take_plugin_dir(&dir, &plugin_id)?;
    crate::core::app_log::emit(&app, "info", &format!("[插件] 已卸载: {plugin_id}"));
    Ok(UninstallResult {
        id: plugin_id,
        needs_restart: false,
    })
}

/// 真正删除已挪到回收目录的插件文件。
///
/// 前端在 `reloadPluginSystem()`（会触发 onDestroy、卸载组件）之后调用。
/// 删不掉就保留回收目录，等下次启动清理 —— 不报错打断用户。
#[tauri::command]
pub fn purge_uninstalled_plugin(app: AppHandle, plugin_id: String) -> Result<bool, String> {
    validate_plugin_id(&plugin_id)?;
    let dir = plugins_dir(&app)?;
    let Ok(rd) = fs::read_dir(&dir) else {
        return Ok(false);
    };

    let prefix = format!(".uninstalled-{plugin_id}-");
    let mut purged = false;
    for entry in rd.flatten() {
        let p = entry.path();
        let Some(name) = p.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if name.starts_with(&prefix) {
            match fs::remove_dir_all(&p) {
                Ok(()) => purged = true,
                Err(e) => {
                    crate::core::app_log::emit(
                        &app,
                        "warn",
                        &format!("[插件] 暂时无法删除 {name}（{e}），将在下次启动时清理"),
                    );
                }
            }
        }
    }
    Ok(purged)
}

/// 启动时清理历史遗留的临时/回收目录（上次卸载没删干净、安装中断等）
pub fn cleanup_stale_dirs(plugins_dir: &Path) {
    let Ok(rd) = fs::read_dir(plugins_dir) else {
        return;
    };
    for entry in rd.flatten() {
        let p = entry.path();
        if !p.is_dir() {
            continue;
        }
        let Some(name) = p.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if name.starts_with(".installing-") || name.starts_with(".replacing-") {
            // 安装/升级中途留下的半成品，直接删
            let _ = fs::remove_dir_all(&p);
        } else if name.starts_with(".uninstalled-") {
            // 上次卸载没删掉的，这次再试（此时插件肯定没被加载）
            let _ = fs::remove_dir_all(&p);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "infoboard-pack-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    /// 造一个插件包（用 zip 写入，与真实打包脚本一致）
    fn make_package(path: &Path, id: &str, entry: &str, entry_src: &str) {
        use std::io::Write;
        let file = fs::File::create(path).unwrap();
        let mut zw = zip::ZipWriter::new(file);
        let opts: zip::write::FileOptions<'_, ()> =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);

        let manifest = format!(
            r#"{{"id":"{id}","name":"n","version":"1.0.0","section":"info","icon":"x","entry":"{entry}"}}"#
        );
        zw.start_file("manifest.json", opts).unwrap();
        zw.write_all(manifest.as_bytes()).unwrap();
        zw.start_file(entry, opts).unwrap();
        zw.write_all(entry_src.as_bytes()).unwrap();
        zw.finish().unwrap();
    }

    #[test]
    fn validate_id_accepts_normal_ids() {
        for id in ["hello-world", "my_plugin", "plug.v2", "a", "A1"] {
            assert!(validate_plugin_id(id).is_ok(), "{id} 应被接受");
        }
    }

    #[test]
    fn validate_id_rejects_path_semantics() {
        for id in ["", "..", ".", "../evil", "a/b", "a\\b", ".hidden", "trail.", "中文"] {
            assert!(validate_plugin_id(id).is_err(), "{id} 应被拒绝");
        }
    }

    #[test]
    fn installs_plugin_from_package() {
        let root = temp_root("install");
        let plugins = root.join("plugins");
        let pkg = root.join("p.ibplugin");
        make_package(&pkg, "plug-a", "index.tsx", "export default 1");

        let id = install_plugin_package(&plugins, &pkg).unwrap();
        assert_eq!(id, "plug-a");

        let installed = plugins.join("plug-a");
        assert!(installed.join("manifest.json").is_file());
        assert_eq!(
            fs::read_to_string(installed.join("index.tsx")).unwrap(),
            "export default 1"
        );
        // 临时目录不应残留
        let leftovers: Vec<_> = fs::read_dir(&plugins)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with('.'))
            .collect();
        assert!(leftovers.is_empty(), "不应残留临时目录: {leftovers:?}");

        let _ = fs::remove_dir_all(&root);
    }

    /// 覆盖安装（升级）：旧版本被替换，且不残留备份目录
    #[test]
    fn reinstall_overwrites_existing() {
        let root = temp_root("reinstall");
        let plugins = root.join("plugins");

        let pkg1 = root.join("v1.ibplugin");
        make_package(&pkg1, "plug-a", "index.tsx", "v1");
        install_plugin_package(&plugins, &pkg1).unwrap();

        let pkg2 = root.join("v2.ibplugin");
        make_package(&pkg2, "plug-a", "index.tsx", "v2");
        install_plugin_package(&plugins, &pkg2).unwrap();

        assert_eq!(
            fs::read_to_string(plugins.join("plug-a").join("index.tsx")).unwrap(),
            "v2",
            "覆盖安装应替换旧版本"
        );
        let leftovers: Vec<_> = fs::read_dir(&plugins)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with('.'))
            .collect();
        assert!(leftovers.is_empty(), "不应残留备份目录: {leftovers:?}");

        let _ = fs::remove_dir_all(&root);
    }

    /// 回归：包内条目路径逃逸（zip slip）必须被拒绝，且不写出任何文件
    #[test]
    fn rejects_zip_slip_entry() {
        use std::io::Write;
        let root = temp_root("slip");
        let plugins = root.join("plugins");
        let pkg = root.join("evil.ibplugin");

        let file = fs::File::create(&pkg).unwrap();
        let mut zw = zip::ZipWriter::new(file);
        let opts: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default();
        zw.start_file("manifest.json", opts).unwrap();
        zw.write_all(br#"{"id":"evil","name":"n","version":"1","section":"info","icon":"x","entry":"index.tsx"}"#).unwrap();
        zw.start_file("../escaped.txt", opts).unwrap();
        zw.write_all(b"PWNED").unwrap();
        zw.start_file("index.tsx", opts).unwrap();
        zw.write_all(b"x").unwrap();
        zw.finish().unwrap();

        let err = install_plugin_package(&plugins, &pkg).unwrap_err();
        assert!(err.contains("非法路径"), "错误应指出非法路径: {err}");
        assert!(!root.join("escaped.txt").exists(), "不应写出逃逸文件");
        assert!(!plugins.join("evil").exists(), "不应留下半成品");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_package_without_manifest() {
        use std::io::Write;
        let root = temp_root("nomanifest");
        let plugins = root.join("plugins");
        let pkg = root.join("bad.ibplugin");

        let file = fs::File::create(&pkg).unwrap();
        let mut zw = zip::ZipWriter::new(file);
        let opts: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default();
        zw.start_file("index.tsx", opts).unwrap();
        zw.write_all(b"x").unwrap();
        zw.finish().unwrap();

        let err = install_plugin_package(&plugins, &pkg).unwrap_err();
        assert!(err.contains("manifest.json"), "错误应提到缺 manifest: {err}");

        let _ = fs::remove_dir_all(&root);
    }

    /// manifest 合法但入口文件缺失 → 不留半成品
    #[test]
    fn rejects_missing_entry_file() {
        use std::io::Write;
        let root = temp_root("noentry");
        let plugins = root.join("plugins");
        let pkg = root.join("bad.ibplugin");

        let file = fs::File::create(&pkg).unwrap();
        let mut zw = zip::ZipWriter::new(file);
        let opts: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default();
        zw.start_file("manifest.json", opts).unwrap();
        zw.write_all(br#"{"id":"plug-x","name":"n","version":"1","section":"info","icon":"x","entry":"index.tsx"}"#).unwrap();
        zw.finish().unwrap();

        let err = install_plugin_package(&plugins, &pkg).unwrap_err();
        assert!(err.contains("入口文件不存在"), "错误应指出入口缺失: {err}");
        assert!(!plugins.join("plug-x").exists(), "不应留下半成品");

        let _ = fs::remove_dir_all(&root);
    }

    /// manifest 里 id 含路径语义 → 直接拒绝（否则目录名就成了逃逸手段）
    #[test]
    fn rejects_manifest_id_with_path_semantics() {
        let root = temp_root("badid");
        let plugins = root.join("plugins");
        let pkg = root.join("bad.ibplugin");
        make_package(&pkg, "..", "index.tsx", "x");

        let err = install_plugin_package(&plugins, &pkg).unwrap_err();
        assert!(err.contains("非法字符") || err.contains("路径片段"), "{err}");

        let _ = fs::remove_dir_all(&root);
    }

    /// section 不是 info/tool → 拒绝（与扫描时同一套校验）
    #[test]
    fn rejects_invalid_section() {
        use std::io::Write;
        let root = temp_root("badsection");
        let plugins = root.join("plugins");
        let pkg = root.join("bad.ibplugin");

        let file = fs::File::create(&pkg).unwrap();
        let mut zw = zip::ZipWriter::new(file);
        let opts: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default();
        zw.start_file("manifest.json", opts).unwrap();
        zw.write_all(br#"{"id":"plug-y","name":"n","version":"1","section":"evil","icon":"x","entry":"index.tsx"}"#).unwrap();
        zw.start_file("index.tsx", opts).unwrap();
        zw.write_all(b"x").unwrap();
        zw.finish().unwrap();

        let err = install_plugin_package(&plugins, &pkg).unwrap_err();
        assert!(err.contains("section"), "{err}");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn list_and_uninstall_roundtrip() {
        let root = temp_root("list");
        let plugins = root.join("plugins");
        let pkg = root.join("p.ibplugin");
        make_package(&pkg, "plug-a", "index.tsx", "x");
        install_plugin_package(&plugins, &pkg).unwrap();

        let list = list_plugins(&plugins);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "plug-a");
        assert!(!list[0].manual, "由本功能安装的应标记为非手动");

        // 卸载：目录被挪走，插件不再出现在列表里
        let trash = take_plugin_dir(&plugins, "plug-a").unwrap();
        assert!(list_plugins(&plugins).is_empty());
        assert!(trash.exists(), "回收目录应存在");
        fs::remove_dir_all(&trash).unwrap();

        let _ = fs::remove_dir_all(&root);
    }

    /// 手动放进来的目录：目录名与 id 不同时也要能列出并卸载
    #[test]
    fn handles_manually_placed_plugin() {
        let root = temp_root("manual");
        let plugins = root.join("plugins");
        let dir = plugins.join("my-folder-name");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("manifest.json"),
            r#"{"id":"plug-a","name":"手动","version":"1","section":"info","icon":"x","entry":"index.tsx"}"#,
        )
        .unwrap();
        fs::write(dir.join("index.tsx"), "x").unwrap();

        let list = list_plugins(&plugins);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "plug-a");
        assert_eq!(list[0].dir_name, "my-folder-name");
        assert!(list[0].manual, "目录名 != id 应标记为手动放置");

        // 按 id 卸载（目录名不同）
        let trash = take_plugin_dir(&plugins, "plug-a").unwrap();
        assert!(trash.exists());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn cleanup_removes_stale_temp_dirs() {
        let root = temp_root("cleanup");
        let plugins = root.join("plugins");
        fs::create_dir_all(plugins.join(".installing-x-0")).unwrap();
        fs::create_dir_all(plugins.join(".replacing-x-0")).unwrap();
        fs::create_dir_all(plugins.join(".uninstalled-x-1")).unwrap();
        fs::create_dir_all(plugins.join("real-plugin")).unwrap();

        cleanup_stale_dirs(&plugins);

        assert!(!plugins.join(".installing-x-0").exists());
        assert!(!plugins.join(".replacing-x-0").exists());
        assert!(!plugins.join(".uninstalled-x-1").exists());
        assert!(plugins.join("real-plugin").exists(), "真实插件目录不能被误删");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn read_manifest_from_package_works() {
        let root = temp_root("readmanifest");
        let pkg = root.join("p.ibplugin");
        make_package(&pkg, "plug-a", "index.tsx", "x");

        let text = read_manifest_from_package(&pkg).unwrap();
        assert!(text.contains("\"id\":\"plug-a\""));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn non_zip_package_is_rejected() {
        let root = temp_root("notzip");
        let pkg = root.join("bad.ibplugin");
        fs::write(&pkg, b"this is not a zip").unwrap();

        let err = read_manifest_from_package(&pkg).unwrap_err();
        assert!(err.contains("zip"), "{err}");

        let _ = fs::remove_dir_all(&root);
    }

    /// 前后端格式契约：读**打包脚本真实产出的文件**。
    ///
    /// 文件由 `node scripts/pack-plugin.mjs plugins` 生成并提交到仓库。
    /// 这样"脚本写出的 zip"和"应用读的 zip"不会各改各的 —— 任何一方改坏都会在这里失败。
    /// 重新生成：`node scripts/pack-plugin.mjs plugins`
    #[test]
    fn installs_real_package_produced_by_pack_script() {
        const REAL_PKG: &[u8] = include_bytes!("../../../dist-plugins/hello-world-1.0.0.ibplugin");

        let root = temp_root("realpkg");
        let plugins = root.join("plugins");
        let pkg = root.join("hello-world-1.0.0.ibplugin");
        fs::write(&pkg, REAL_PKG).unwrap();

        // 先确认 manifest 能被正确读出（id 取对了，说明 zip 结构没问题）
        let manifest_text = read_manifest_from_package(&pkg).unwrap();
        assert!(
            manifest_text.contains("\"hello-world\""),
            "打包脚本产出的 manifest 内容异常: {manifest_text}"
        );

        let id = install_plugin_package(&plugins, &pkg).unwrap();
        assert_eq!(id, "hello-world");

        let installed = plugins.join("hello-world");
        assert!(installed.join("manifest.json").is_file());
        assert!(installed.join("index.tsx").is_file(), "入口文件应被解出");

        // 解出的内容要和仓库里的示例源码一致（确实完整解压，不是空文件）
        let src = fs::read_to_string(installed.join("index.tsx")).unwrap();
        assert!(src.contains("HelloWorldPlugin"), "解出的入口内容不对");

        let list = list_plugins(&plugins);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "你好世界");

        let _ = fs::remove_dir_all(&root);
    }
}
