/**
 * 设置的默认值与读取校验（纯函数，无 React / DOM 依赖，便于单测）
 */

import type { Settings, ThemeMode } from './types'

export const DEFAULT_SETTINGS: Settings = {
  weatherCity: '101010100',
  weatherCityName: '北京',
  weatherApiHost: '',
  theme: 'system',
  disabledPlugins: [],
  autoStart: false,
}

const THEME_MODES: readonly ThemeMode[] = ['light', 'dark', 'pink-purple', 'system']

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

/**
 * 把 localStorage 里反序列化出来的任意值收敛成合法的 Settings。
 * 字段类型不对就回退默认值，未知字段丢弃，避免脏数据让设置面板抛错白屏。
 *
 * 注意：`weatherApiKey` 已不在设置里（改存 Windows 凭据管理器）。
 * 旧数据里的这个字段会被这里丢弃，启动时由 `secrets.migrateLegacyWeatherKey()`
 * 先迁移再清理，所以不能在这里读它（读不到就等于已经把用户的 Key 弄丢了）。
 */
export function sanitizeSettings(raw: unknown): Settings {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ...DEFAULT_SETTINGS, disabledPlugins: [] }
  }
  const r = raw as Record<string, unknown>
  return {
    weatherCity: str(r.weatherCity, DEFAULT_SETTINGS.weatherCity),
    weatherCityName: str(r.weatherCityName, DEFAULT_SETTINGS.weatherCityName),
    weatherApiHost: str(r.weatherApiHost, DEFAULT_SETTINGS.weatherApiHost),
    theme: THEME_MODES.includes(r.theme as ThemeMode)
      ? (r.theme as ThemeMode)
      : DEFAULT_SETTINGS.theme,
    disabledPlugins: Array.isArray(r.disabledPlugins)
      ? r.disabledPlugins.filter((x): x is string => typeof x === 'string')
      : [],
    autoStart: typeof r.autoStart === 'boolean' ? r.autoStart : DEFAULT_SETTINGS.autoStart,
  }
}
