/**
 * 主题强调色（accent）的组件树共享。
 *
 * 为什么需要 Context：WeatherCard / TodoCard 的子组件（CompactView、ExpandedView、
 * DetailGrid…）原先通过**模块级可变变量**拿主题色 ——
 *
 * ```ts
 * let ACCENT = '#DA7756'          // 模块级
 * export function WeatherCard() {
 *   ACCENT = accent               // 渲染期写模块级变量
 *   ...
 * }
 * ```
 *
 * 两个问题：
 * 1. 渲染期产生副作用；React 18+ 并发渲染下会撕裂（渲染被丢弃/重放时，
 *    其他树的子组件可能读到"别人的"颜色）
 * 2. 同一个卡片被渲染两份（如展开面板 + 主区）时互相覆盖
 *
 * 改为 Context 后子组件直接订阅，既去掉模块级可变状态，也不用手工透传 props。
 */

import { createContext, useContext } from 'react'

/** 与 globals.css 的 :root --accent 保持一致，作为无 Provider 时的兜底 */
export const FALLBACK_ACCENT = '#DA7756'

const AccentContext = createContext<string>(FALLBACK_ACCENT)

export const AccentProvider = AccentContext.Provider

/** 读取当前主题强调色（无 Provider 时返回兜底色） */
export function useAccent(): string {
  return useContext(AccentContext)
}
