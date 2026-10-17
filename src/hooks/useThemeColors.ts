/**
 * 主题色响应式 Hook
 *
 * 从 themeColorStore 订阅当前 accent 颜色值，
 * 主题切换时自动更新，零重复读取。
 */

import { useSyncExternalStore } from 'react'
import { subscribe, getSnapshot } from '../stores/themeColorStore'
import { withAlpha } from '../utils/themeColor'

/**
 * 获取当前主题的强调色及其衍生色
 *
 * @example
 * ```tsx
 * const { accent, withAlpha } = useThemeColors()
 * <WeatherIcon color={accent} />
 * <div style={{ backgroundColor: withAlpha(accent, 0.08) }} />
 * ```
 */
export function useThemeColors() {
  // 第三个参数（getServerSnapshot）必须给：缺了它，任何服务端渲染或基于
  // renderToStaticMarkup 的测试都会抛 "Missing getServerSnapshot"。
  // 这个 store 无副作用，直接复用同一个读函数即可。
  const accent = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  return { accent, withAlpha }
}
