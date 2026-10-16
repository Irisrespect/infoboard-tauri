/**
 * 外部插件加载器
 *
 * 职责：
 * 1. 调用 Rust 扫描 plugins/ 目录
 * 2. 动态导入外部插件模块
 * 3. 验证插件格式合法性
 * 4. 返回加载成功的插件列表
 */

import { invoke } from '@tauri-apps/api/core'
import type { InfoBoardPlugin, ExternalPluginMeta } from './types'

export class PluginLoader {
  /**
   * 加载所有外部插件
   *
   * @returns 成功加载的插件数组
   */
  async loadExternalPlugins(): Promise<InfoBoardPlugin[]> {
    try {
      // 调用 Rust 命令扫描插件目录
      const metas: ExternalPluginMeta[] = await invoke('scan_external_plugins')

      console.log(`[PluginLoader] 发现 ${metas.length} 个外部插件`)

      const plugins: InfoBoardPlugin[] = []

      for (const meta of metas) {
        try {
          const plugin = await this.loadPlugin(meta)
          if (plugin) {
            plugins.push(plugin)
            console.log(`[PluginLoader] 成功加载: ${meta.id}`)
          }
        } catch (err) {
          console.error(`[PluginLoader] 加载失败: ${meta.id}`, err)
        }
      }

      return plugins
    } catch (err) {
      console.error('[PluginLoader] 扫描插件目录失败', err)
      return []
    }
  }

  /**
   * 加载单个外部插件
   *
   * @param meta - 插件元数据
   * @returns 插件对象，加载失败返回 null
   */
  private async loadPlugin(meta: ExternalPluginMeta): Promise<InfoBoardPlugin | null> {
    try {
      // 动态导入插件模块
      // @vite-ignore 告诉 Vite 不要在构建时处理此导入
      const module = await import(/* @vite-ignore */ meta.entryPath)

      // 插件可以通过 default 或具名导出
      const pluginExport = module.default || module.plugin

      if (!pluginExport) {
        console.error(`[PluginLoader] ${meta.id}: 未找到导出（需要 default 或 plugin）`)
        return null
      }

      // 验证插件格式
      if (!this.validatePlugin(pluginExport)) {
        console.error(`[PluginLoader] ${meta.id}: 插件格式不合法`)
        return null
      }

      // 标记为外部插件
      const plugin: InfoBoardPlugin = {
        ...pluginExport,
        type: 'external',
        sourcePath: meta.path,
        manifest: {
          ...pluginExport.manifest,
          version: meta.manifest.version,
          author: meta.manifest.author,
          description: meta.manifest.description,
        },
      }

      return plugin
    } catch (err) {
      console.error(`[PluginLoader] ${meta.id}: 导入失败`, err)
      return null
    }
  }

  /**
   * 验证插件对象格式
   *
   * @param plugin - 待验证的插件对象
   * @returns 是否合法
   */
  private validatePlugin(plugin: unknown): plugin is InfoBoardPlugin {
    if (!plugin || typeof plugin !== 'object') {
      return false
    }

    const p = plugin as Partial<InfoBoardPlugin>

    // 必须有 manifest
    if (!p.manifest || typeof p.manifest !== 'object') {
      console.error('[PluginLoader] 缺少 manifest')
      return false
    }

    const manifest = p.manifest

    // 必须有 id
    if (typeof manifest.id !== 'string' || !manifest.id) {
      console.error('[PluginLoader] manifest.id 无效')
      return false
    }

    // 必须有 name
    if (typeof manifest.name !== 'string' || !manifest.name) {
      console.error('[PluginLoader] manifest.name 无效')
      return false
    }

    // 必须有 section
    if (manifest.section !== 'info' && manifest.section !== 'tool') {
      console.error('[PluginLoader] manifest.section 必须是 "info" 或 "tool"')
      return false
    }

    // 必须有 Component
    if (typeof p.Component !== 'function') {
      console.error('[PluginLoader] Component 必须是 React 组件')
      return false
    }

    return true
  }

  /**
   * 重新加载外部插件
   *
   * 用于插件热重载场景
   */
  async reloadExternalPlugins(): Promise<InfoBoardPlugin[]> {
    console.log('[PluginLoader] 重新加载外部插件...')
    return this.loadExternalPlugins()
  }
}

// 单例导出
export const pluginLoader = new PluginLoader()
