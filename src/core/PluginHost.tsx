/**
 * 插件宿主
 *
 * 负责：
 * 1. 加载并注册所有插件（内置 + 外部）
 * 2. 根据 section 字段分配到信息区/工具区
 * 3. 渲染每个插件的 Component
 */

import { useEffect, useState } from 'react'
import { pluginRegistry } from './PluginRegistry'
import { pluginLoader } from './PluginLoader'
import type { InfoBoardPlugin } from './types'

const SETTINGS_KEY = 'infoboard-settings'

/**
 * 从 localStorage 读取已禁用的插件 ID 列表
 */
function getDisabledPlugins(): string[] {
  try {
    const stored = localStorage.getItem(SETTINGS_KEY)
    if (stored) {
      const parsed = JSON.parse(stored)
      if (Array.isArray(parsed.disabledPlugins)) {
        return parsed.disabledPlugins
      }
    }
  } catch {
    // 解析失败返回空列表
  }
  return []
}

/**
 * 初始化插件系统
 * 加载所有插件并注册到 PluginRegistry
 * 返回 Promise，调用方可以等待加载完成。
 * 使用 promise 门防止并发重复初始化。
 */
let initPromise: Promise<void> | null = null

export function initPluginSystem(): Promise<void> {
  if (initPromise) return initPromise

  initPromise = (async () => {
    pluginRegistry.clear()
    await importPlugins()
  })()

  return initPromise
}

/**
 * 重新加载插件系统
 *
 * 用于插件热重载场景
 */
export async function reloadPluginSystem(): Promise<void> {
  console.log('[PluginHost] 重新加载插件系统...')
  initPromise = null
  await initPluginSystem()
}

/**
 * 导入并注册所有插件（内置 + 外部）
 */
async function importPlugins(): Promise<void> {
  // 1. 加载内置插件
  await importBuiltinPlugins()

  // 2. 加载外部插件
  await importExternalPlugins()
}

/**
 * 导入并注册内置插件
 */
async function importBuiltinPlugins(): Promise<void> {
  try {
    // 动态导入插件入口
    const pluginsModule = await import('../plugins')

    // 支持两种导出方式：
    // 1. 导出数组：export const plugins: InfoBoardPlugin[] = [...]
    // 2. 导出单个插件：export const weatherPlugin: InfoBoardPlugin = {...}
    if (pluginsModule.plugins && Array.isArray(pluginsModule.plugins)) {
      // 方式1：数组导出
      const builtinPlugins = pluginsModule.plugins.map((p) => ({
        ...p,
        type: 'builtin' as const,
      }))
      pluginRegistry.registerAll(builtinPlugins)
    } else {
      // 方式2：逐个导出
      const allExports = Object.values(pluginsModule)
      const plugins: InfoBoardPlugin[] = allExports
        .filter(
          (item) =>
            item !== null && typeof item === 'object' && 'manifest' in item && 'Component' in item
        )
        .map((p) => ({
          ...(p as InfoBoardPlugin),
          type: 'builtin' as const,
        }))
      pluginRegistry.registerAll(plugins)
    }

    console.log(`[PluginHost] 已加载 ${pluginRegistry.size} 个内置插件`)
  } catch (error) {
    // plugins/index.ts 可能还不存在，这是正常的
    console.warn('[PluginHost] 加载内置插件失败或插件目录为空:', error)
  }
}

/**
 * 导入并注册外部插件
 */
async function importExternalPlugins(): Promise<void> {
  try {
    const externalPlugins = await pluginLoader.loadExternalPlugins()

    if (externalPlugins.length > 0) {
      pluginRegistry.registerAll(externalPlugins)
      console.log(`[PluginHost] 已加载 ${externalPlugins.length} 个外部插件`)
    }
  } catch (error) {
    console.error('[PluginHost] 加载外部插件失败:', error)
  }
}

/**
 * 插件宿主组件属性
 */
interface PluginHostProps {
  /** 区域类型 */
  section: 'info' | 'tool'

  /** 自定义渲染函数（可选） */
  renderPlugin?: (plugin: InfoBoardPlugin) => React.ReactNode

  /** 子组件（可选，用于包装容器） */
  children?: React.ReactNode
}

/**
 * 插件宿主组件
 *
 * 根据 section 渲染对应的插件列表
 *
 * @example
 * ```tsx
 * // 渲染信息区插件
 * <PluginHost section="info" />
 *
 * // 渲染工具区插件
 * <PluginHost section="tool" />
 *
 * // 自定义渲染
 * <PluginHost
 *   section="info"
 *   renderPlugin={(plugin) => (
 *     <CustomWrapper key={plugin.manifest.id}>
 *       <plugin.Component manifest={plugin.manifest} />
 *     </CustomWrapper>
 *   )}
 * />
 * ```
 */
export function PluginHost({ section, renderPlugin, children }: PluginHostProps) {
  const plugins = pluginRegistry.getPluginsBySection(section)

  if (plugins.length === 0) {
    return (
      <div className="flex items-center justify-center text-text-muted text-sm p-4">
        暂无{section === 'info' ? '信息区' : '工具区'}插件
      </div>
    )
  }

  return (
    <>
      {plugins.map((plugin) =>
        renderPlugin ? (
          renderPlugin(plugin)
        ) : (
          <PluginRenderer key={plugin.manifest.id} plugin={plugin} />
        )
      )}
      {children}
    </>
  )
}

/**
 * 默认插件渲染器
 */
function PluginRenderer({ plugin }: { plugin: InfoBoardPlugin }) {
  const { Component, manifest } = plugin

  return (
    <div
      key={manifest.id}
      className="plugin-container"
      data-plugin-id={manifest.id}
      data-plugin-section={manifest.section}
    >
      <Component manifest={manifest} />
    </div>
  )
}

/**
 * React Hook：使用插件系统
 *
 * 在组件挂载时初始化插件系统
 *
 * @example
 * ```tsx
 * function App() {
 *   usePluginSystem()
 *   return <PluginHost section="info" />
 * }
 * ```
 */
export function usePluginSystem(): void {
  useEffect(() => {
    initPluginSystem()
  }, [])
}

/**
 * React Hook：获取指定区域的插件列表
 *
 * 自动初始化插件系统，并在插件加载完成后触发重新渲染
 *
 * @param section - 区域类型
 * @returns 插件数组
 *
 * @example
 * ```tsx
 * function InfoSection() {
 *   const infoPlugins = usePlugins('info')
 *   return (
 *     <div>
 *       {infoPlugins.map(plugin => (
 *         <plugin.Component key={plugin.manifest.id} manifest={plugin.manifest} />
 *       ))}
 *     </div>
 *   )
 * }
 * ```
 */
export function usePlugins(section: 'info' | 'tool'): InfoBoardPlugin[] {
  // 用计数器强制触发重新渲染
  const [, setVersion] = useState(0)
  // 从 localStorage 读取已禁用的插件（settings 插件始终不排除）
  const [disabledPlugins, setDisabledPlugins] = useState<string[]>(() =>
    getDisabledPlugins().filter((id) => id !== 'settings')
  )

  // 初始化插件系统（promise 门防止并发重复调用）
  useEffect(() => {
    initPluginSystem().then(() => {
      setVersion((v) => v + 1)
    })
  }, [])

  // 监听设置变更（插件启用/禁用切换时触发重新渲染）
  useEffect(() => {
    const handleSettingsChanged = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (detail?.key === 'disabledPlugins') {
        setDisabledPlugins(getDisabledPlugins().filter((id) => id !== 'settings'))
        setVersion((v) => v + 1)
      }
    }

    window.addEventListener('settings:changed', handleSettingsChanged)
    return () => window.removeEventListener('settings:changed', handleSettingsChanged)
  }, [])

  // 过滤已禁用的插件（settings 始终保留）
  return pluginRegistry
    .getPluginsBySection(section)
    .filter((p) => !disabledPlugins.includes(p.manifest.id))
}
