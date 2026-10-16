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
use std::path::PathBuf;

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

/// Tauri 命令: 扫描外部插件目录
///
/// 返回所有有效插件的元数据
#[tauri::command]
pub fn scan_external_plugins() -> Result<Vec<ExternalPluginMeta>, String> {
    // plugins/ 目录相对于可执行文件
    let plugins_dir = PathBuf::from("plugins");

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
                // 构造入口文件绝对路径
                let entry_path = plugin_dir.join(&manifest.entry);

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
