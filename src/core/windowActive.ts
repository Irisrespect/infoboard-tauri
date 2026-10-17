/**
 * 主窗口活跃状态（外部 store）
 *
 * 窗口被隐藏到托盘（或最小化）后前端必须停止轮询/动画，否则后台持续耗电。
 * 但 WebView2 在 Rust 侧 `hide()` 之后 `document.visibilityState` 仍然是 `visible`、
 * 也不会派发 `visibilitychange`（已在真实应用里实测），所以**不能**用页面可见性 API
 * 判断，必须由 Rust 通过 `window:visibility` 事件主动通知。
 *
 * 这里把"监听 + 取初值"的状态机抽成与 React 无关的 store，
 * 便于在 vitest 里直接断言（本仓库没有 DOM 测试环境）。
 */

import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import { listen as tauriListen } from '@tauri-apps/api/event'

/** Rust 侧 `core::window::set_main_visible` 派发的事件名 */
export const WINDOW_VISIBILITY_EVENT = 'window:visibility'

/** Rust 侧读取活跃状态的命令名 */
export const WINDOW_IS_ACTIVE_COMMAND = 'window_is_active'

/** listen 回调收到的事件形状（只用到 payload） */
interface VisibilityEvent {
  payload: unknown
}

export interface WindowActiveDeps {
  invoke: (cmd: string) => Promise<unknown>
  listen: (event: string, handler: (event: VisibilityEvent) => void) => Promise<() => void>
}

export interface WindowActiveStore {
  /** 当前值。稳定返回，可直接交给 useSyncExternalStore */
  getSnapshot(): boolean
  /** 订阅变化，返回取消订阅函数 */
  subscribe(listener: () => void): () => void
  /** 挂监听并读取初值。可重复调用（start 后 stop 再 start） */
  start(): Promise<void>
  /** 停止：取消事件监听 */
  stop(): void
}

const defaultDeps: WindowActiveDeps = {
  invoke: (cmd) => tauriInvoke<unknown>(cmd),
  listen: (event, handler) => tauriListen(event, (e) => handler({ payload: e.payload })),
}

export function createWindowActiveStore(deps: WindowActiveDeps = defaultDeps): WindowActiveStore {
  let active = true
  /** 是否已收到过事件：收到过就不能再用 invoke 的初值覆盖（初值可能更旧） */
  let gotEvent = false
  const listeners = new Set<() => void>()
  let unlisten: (() => void) | null = null
  /** 是否处于监听中。stop() 之后即便事件源仍在推送也一律忽略 */
  let listening = false
  /** 用于丢弃"stop 之后才 resolve 的 start" */
  let generation = 0

  const set = (next: boolean) => {
    if (active === next) return
    active = next
    for (const listener of [...listeners]) listener()
  }

  return {
    getSnapshot: () => active,

    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    async start() {
      const mine = ++generation

      // 先挂监听再取初值，避免两步之间的事件被丢掉
      try {
        const off = await deps.listen(WINDOW_VISIBILITY_EVENT, (event) => {
          if (!listening) return
          gotEvent = true
          set(Boolean(event.payload))
        })
        if (mine !== generation) {
          // 期间已被 stop()（例如 StrictMode 下 effect 走了一遍清理）
          off()
          return
        }
        unlisten = off
        listening = true
      } catch (err) {
        console.warn('[windowActive] 监听窗口可见性事件失败:', err)
      }

      try {
        const initial = await deps.invoke(WINDOW_IS_ACTIVE_COMMAND)
        if (mine === generation && !gotEvent) set(Boolean(initial))
      } catch (err) {
        // 非 Tauri 环境（浏览器 / 测试）没有该命令，保持默认 true
        console.debug('[windowActive] 读取窗口活跃状态失败:', err)
      }
    },

    stop() {
      generation += 1
      gotEvent = false
      listening = false
      if (unlisten) {
        unlisten()
        unlisten = null
      }
    },
  }
}
