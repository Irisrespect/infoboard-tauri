/**
 * 插件包导入 / 卸载（前端桥接）
 *
 * 对应 Rust 侧 `src-tauri/src/plugins/pack.rs`：
 * - 安装：`.ibplugin`（zip，根目录含 manifest.json + 入口文件）→ 解压进插件目录
 * - 卸载：先把插件目录改名挪走（Windows 上被加载中的组件占用会删不掉），
 *   再重新加载插件系统触发组件卸载，最后真正删除
 */

import { invoke } from '@tauri-apps/api/core'

/** 插件包扩展名 */
export const PLUGIN_PACKAGE_EXT = 'ibplugin'

/** 已安装的外部插件 */
export interface InstalledPlugin {
  id: string
  name: string
  version: string
  author: string
  description: string
  section: string
  icon: string
  /** 插件目录名（手动放置时可能与 id 不同） */
  dirName: string
  /** 是否为手动放进目录的（非本功能安装） */
  manual: boolean
}

/** 安装插件包，返回插件 id */
export async function installPluginPackage(packagePath: string): Promise<string> {
  return await invoke<string>('install_plugin_package_cmd', { packagePath })
}

/** 列出插件目录下已安装的外部插件 */
export async function listInstalledPlugins(): Promise<InstalledPlugin[]> {
  return await invoke<InstalledPlugin[]>('list_installed_plugins')
}

/** 卸载第一步：把插件目录挪到回收目录（此后插件已不再被扫描到） */
export async function uninstallPlugin(pluginId: string): Promise<void> {
  await invoke('uninstall_plugin', { pluginId })
}

/**
 * 卸载第二步：真正删除文件。
 *
 * 必须在 `reloadPluginSystem()` 之后调用 —— 那时旧组件已经卸载，
 * 文件不再被占用，才删得掉。删不掉也不会抛错（留着下次启动清理）。
 */
export async function purgeUninstalledPlugin(pluginId: string): Promise<void> {
  await invoke('purge_uninstalled_plugin', { pluginId })
}

/** 判断路径是否像插件包（用于拖拽时的即时反馈） */
export function looksLikePluginPackage(path: string): boolean {
  return path.toLowerCase().endsWith(`.${PLUGIN_PACKAGE_EXT}`)
}
