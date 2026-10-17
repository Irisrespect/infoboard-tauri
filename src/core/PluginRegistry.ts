/**
 * 插件注册表
 *
 * 负责管理所有插件的注册、查询、生命周期
 * 单例模式，全局唯一实例
 */

import type { InfoBoardPlugin, PluginManifest } from './types'

export class PluginRegistry {
  /** 已注册的插件映射表 (id -> plugin) */
  private plugins: Map<string, InfoBoardPlugin> = new Map()

  /**
   * 注册插件
   * @param plugin - 完整的插件定义
   * @throws 如果 id 重复则抛出错误
   */
  register(plugin: InfoBoardPlugin): void {
    const { id } = plugin.manifest

    if (this.plugins.has(id)) {
      throw new Error(`插件 "${id}" 已存在，不能重复注册`)
    }

    this.plugins.set(id, plugin)

    // 调用初始化钩子；失败则回滚注册，避免留下"已注册但未初始化"的半成品
    try {
      plugin.onInit?.()
    } catch (error) {
      this.plugins.delete(id)
      throw error
    }

    console.log(`[PluginRegistry] 已注册插件: ${id} (${plugin.manifest.section})`)
  }

  /**
   * 批量注册插件（单个失败只记录日志，不影响其余插件）
   * @param plugins - 插件数组
   */
  registerAll(plugins: InfoBoardPlugin[]): void {
    // 单个插件失败（重复 id、onInit 抛错）不能中断整批，否则其后的插件全部丢失
    for (const plugin of plugins) {
      try {
        this.register(plugin)
      } catch (error) {
        console.error(`[PluginRegistry] 注册插件失败: ${plugin.manifest?.id ?? '(未知)'}`, error)
      }
    }
  }

  /**
   * 获取指定插件
   * @param id - 插件唯一标识
   * @returns 插件实例或 undefined
   */
  getPlugin(id: string): InfoBoardPlugin | undefined {
    return this.plugins.get(id)
  }

  /**
   * 获取指定插件（别名方法）
   * @param id - 插件唯一标识
   * @returns 插件实例或 undefined
   */
  get(id: string): InfoBoardPlugin | undefined {
    return this.getPlugin(id)
  }

  /**
   * 获取所有已注册插件
   * @returns 插件数组
   */
  getAllPlugins(): InfoBoardPlugin[] {
    return Array.from(this.plugins.values())
  }

  /**
   * 获取所有已注册插件（别名方法）
   * @returns 插件数组
   */
  getAll(): InfoBoardPlugin[] {
    return this.getAllPlugins()
  }

  /**
   * 获取指定区域的插件（别名方法）
   * @param section - 区域类型
   * @returns 该区域的插件数组
   */
  getBySection(section: 'info' | 'tool'): InfoBoardPlugin[] {
    return this.getPluginsBySection(section)
  }

  /**
   * 获取指定区域的插件
   * @param section - 区域类型
   * @returns 该区域的插件数组
   */
  getPluginsBySection(section: 'info' | 'tool'): InfoBoardPlugin[] {
    return this.getAllPlugins().filter((plugin) => plugin.manifest.section === section)
  }

  /**
   * 获取信息区插件
   * @returns 信息区插件数组
   */
  getInfoPlugins(): InfoBoardPlugin[] {
    return this.getPluginsBySection('info')
  }

  /**
   * 获取工具区插件
   * @returns 工具区插件数组
   */
  getToolPlugins(): InfoBoardPlugin[] {
    return this.getPluginsBySection('tool')
  }

  /**
   * 检查插件是否已注册
   * @param id - 插件唯一标识
   * @returns 是否已注册
   */
  hasPlugin(id: string): boolean {
    return this.plugins.has(id)
  }

  /**
   * 注销插件
   * @param id - 插件唯一标识
   * @returns 是否成功注销
   */
  unregister(id: string): boolean {
    const plugin = this.plugins.get(id)

    if (!plugin) {
      console.warn(`[PluginRegistry] 插件 "${id}" 不存在，无法注销`)
      return false
    }

    // 调用销毁钩子（捕获异常，避免一个插件的错误中断整个清理流程）
    try {
      plugin.onDestroy?.()
    } catch (err) {
      console.error(`[PluginRegistry] 插件 "${id}" 的 onDestroy 抛出错误:`, err)
    }

    this.plugins.delete(id)
    console.log(`[PluginRegistry] 已注销插件: ${id}`)

    return true
  }

  /**
   * 清空所有插件（开发环境热重载时使用）
   */
  clear(): void {
    // 调用所有插件的销毁钩子（捕获异常，避免一个插件的错误中断清理）
    this.plugins.forEach((plugin, id) => {
      try {
        plugin.onDestroy?.()
      } catch (err) {
        console.error(`[PluginRegistry] 插件 "${id}" 的 onDestroy 抛出错误:`, err)
      }
    })

    this.plugins.clear()
    console.log('[PluginRegistry] 已清空所有插件')
  }

  /**
   * 获取已注册插件数量
   * @returns 插件数量
   */
  get size(): number {
    return this.plugins.size
  }
}

// 导出全局单例
export const pluginRegistry = new PluginRegistry()
