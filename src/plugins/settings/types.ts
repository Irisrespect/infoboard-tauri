/**
 * 设置相关类型定义
 */

/** 命名主题 ID */
export type ThemeId = 'light' | 'dark' | 'pink-purple'

/** 主题模式（命名主题 + 跟随系统） */
export type ThemeMode = ThemeId | 'system'

/** 主题预览信息（用于设置面板展示） */
export interface ThemePreview {
  id: ThemeId
  name: string
  /** 预览色块：[强调色, 背景色, 文字色] */
  colors: [string, string, string]
}

/** 所有可选主题的预览数据 */
export const THEME_PREVIEWS: ThemePreview[] = [
  { id: 'light', name: '暖橙浅色', colors: ['#DA7756', '#FAF7F2', '#2C2A26'] },
  { id: 'dark', name: '深色', colors: ['#DA7756', '#2A2A2A', '#F0EDE8'] },
  { id: 'pink-purple', name: '粉紫透明', colors: ['#F0B8D4', '#190F23', '#FFFFFF'] },
]

/** 应用设置 */
export interface Settings {
  /** 天气城市 LocationID（和风天气） */
  weatherCity: string
  /** 天气城市名称（用于显示） */
  weatherCityName: string
  /** 和风天气 API Key */
  weatherApiKey: string
  /** 和风天气 API Host */
  weatherApiHost: string
  /** 主题模式 */
  theme: ThemeMode
  /** 被禁用的插件 ID 列表 */
  disabledPlugins: string[]
  /** 开机自启动 */
  autoStart: boolean
}

/** useSettings Hook 返回值 */
export interface UseSettingsReturn {
  /** 当前设置 */
  settings: Settings
  /** 更新单个设置项 */
  updateSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void
  /** 批量更新设置项（原子操作，只触发一次事件） */
  updateSettings: (patch: Partial<Settings>) => void
  /** 切换插件启用/禁用状态 */
  togglePlugin: (pluginId: string) => void
}
