/**
 * 窗口活跃状态 Hook
 *
 * 见 `windowActive.ts` 的说明：窗口隐藏到托盘后 `document.visibilityState`
 * 不会变化，必须由 Rust 的 `window:visibility` 事件驱动。
 *
 * 用法：
 * ```ts
 * const active = useWindowActive()
 * useEffect(() => { if (!active) return; const t = setInterval(...); return () => clearInterval(t) }, [active])
 * ```
 */

import { useEffect, useState, useSyncExternalStore } from 'react'
import { createWindowActiveStore, type WindowActiveStore } from './windowActive'

export { WINDOW_VISIBILITY_EVENT, WINDOW_IS_ACTIVE_COMMAND } from './windowActive'

/**
 * 订阅主窗口活跃状态。
 *
 * @returns 窗口当前是否活跃（可见且未最小化）。非 Tauri 环境按 true 处理，
 *          与修复前行为一致。
 */
export function useWindowActive(): boolean {
  // 每个 Hook 实例各自持有一份 store，避免多个组件互相干扰
  const [store] = useState<WindowActiveStore>(() => createWindowActiveStore())

  useEffect(() => {
    void store.start()
    return () => store.stop()
  }, [store])

  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}
