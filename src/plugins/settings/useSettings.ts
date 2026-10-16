/**
 * 设置数据逻辑 Hook
 *
 * 负责：
 * 1. 从 localStorage 读取/写入设置
 * 2. 应用主题切换
 * 3. 派发设置变更事件
 */

import { useState, useEffect, useCallback } from 'react'
import type { Settings, ThemeMode, UseSettingsReturn } from './types'

const STORAGE_KEY = 'infoboard-settings'

/** 默认设置 */
const DEFAULT_SETTINGS: Settings = {
  weatherCity: '101010100',
  weatherCityName: '北京',
  weatherApiKey: '',
  weatherApiHost: '',
  theme: 'system',
  disabledPlugins: [],
  autoStart: false,
}

/**
 * 从 localStorage 加载设置
 */
function loadSettings(): Settings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      const parsed = JSON.parse(stored)
      return { ...DEFAULT_SETTINGS, ...parsed }
    }
  } catch {
    // 解析失败使用默认值
  }
  return { ...DEFAULT_SETTINGS }
}

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

  /** 更新单个设置项 */
  const updateSetting = useCallback(<K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings((prev) => {
      const next = { ...prev, [key]: value }
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      } catch {
        // 存储失败忽略
      }
      // 延迟派发事件避免在 React 渲染周期内跨组件 setState
      setTimeout(() => {
        window.dispatchEvent(
          new CustomEvent('settings:changed', {
            detail: { key, value },
          })
        )
      }, 0)
      return next
    })
  }, [])

  /** 批量更新设置项（原子操作，只触发一次事件） */
  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch }
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      } catch {
        // 存储失败忽略
      }
      setTimeout(() => {
        window.dispatchEvent(
          new CustomEvent('settings:changed', {
            detail: { key: 'batch', patch },
          })
        )
      }, 0)
      return next
    })
  }, [])

  /** 切换插件启用/禁用 */
  const togglePlugin = useCallback((pluginId: string) => {
    setSettings((prev) => {
      const disabled = prev.disabledPlugins.includes(pluginId)
        ? prev.disabledPlugins.filter((id) => id !== pluginId)
        : [...prev.disabledPlugins, pluginId]
      const next = { ...prev, disabledPlugins: disabled }
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      } catch {
        // 存储失败忽略
      }
      setTimeout(() => {
        window.dispatchEvent(
          new CustomEvent('settings:changed', {
            detail: { key: 'disabledPlugins', value: disabled },
          })
        )
      }, 0)
      return next
    })
  }, [])

  return { settings, updateSetting, updateSettings, togglePlugin }
}
