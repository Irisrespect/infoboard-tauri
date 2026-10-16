/**
 * 设置数据逻辑 Hook
 *
 * 负责：
 * 1. 从 localStorage 读取/写入设置
 * 2. 应用主题切换
 * 3. 派发设置变更事件
 *
 * 注意（F2）：所有副作用（写盘、派发事件）都在 `setState` **之外**执行。
 * 之前它们写在 `setSettings(prev => …)` 的 updater 里，而 updater 必须是纯函数——
 * React StrictMode 会把 updater 调用两次，于是写盘和事件都重复触发了一遍。
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import type { Settings, ThemeMode, UseSettingsReturn } from './types'
import { loadSettings, persistSettings } from './settingsStorage'

/**
 * 应用主题到 DOM
 */
function applyTheme(theme: ThemeMode): void {
  const root = document.documentElement
  if (theme === 'system') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    root.setAttribute('data-theme', prefersDark ? 'dark' : 'light')
  } else {
    root.setAttribute('data-theme', theme)
  }
}

/**
 * 设置数据 Hook
 */
export function useSettings(): UseSettingsReturn {
  const [settings, setSettings] = useState<Settings>(loadSettings)

  /** 最新设置的同步副本：让连续多次更新能基于最新值累加，而不必依赖 updater */
  const settingsRef = useRef<Settings>(settings)

  // 应用主题
  useEffect(() => {
    applyTheme(settings.theme)
  }, [settings.theme])

  // system 模式下监听系统主题变化
  useEffect(() => {
    if (settings.theme !== 'system') return

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = () => applyTheme('system')
    mediaQuery.addEventListener('change', handler)
    return () => mediaQuery.removeEventListener('change', handler)
  }, [settings.theme])

  /**
   * 统一的提交入口：先算出完整的新设置，再 setState，最后执行副作用。
   * 副作用不放在 updater 内，StrictMode 下不会重复执行。
   */
  const commit = useCallback((next: Settings, detail: unknown) => {
    settingsRef.current = next
    setSettings(next)

    if (!persistSettings(next)) {
      // 写失败不再静默：用户以为改好了，重启却发现没保存
      window.toastAPI?.show?.({
        message: '设置保存失败：本地存储写入被拒绝，重启后可能丢失',
        color: '#ef4444',
      })
    }

    // 延迟派发事件避免在 React 渲染周期内跨组件 setState
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('settings:changed', { detail }))
    }, 0)
  }, [])

  /** 更新单个设置项 */
  const updateSetting = useCallback(
    <K extends keyof Settings>(key: K, value: Settings[K]) => {
      commit({ ...settingsRef.current, [key]: value }, { key, value })
    },
    [commit]
  )

  /** 批量更新设置项（原子操作，只触发一次事件） */
  const updateSettings = useCallback(
    (patch: Partial<Settings>) => {
      commit({ ...settingsRef.current, ...patch }, { key: 'batch', patch })
    },
    [commit]
  )

  /** 切换插件启用/禁用 */
  const togglePlugin = useCallback(
    (pluginId: string) => {
      const prev = settingsRef.current
      const disabled = prev.disabledPlugins.includes(pluginId)
        ? prev.disabledPlugins.filter((id) => id !== pluginId)
        : [...prev.disabledPlugins, pluginId]
      commit({ ...prev, disabledPlugins: disabled }, { key: 'disabledPlugins', value: disabled })
    },
    [commit]
  )

  return { settings, updateSetting, updateSettings, togglePlugin }
}
