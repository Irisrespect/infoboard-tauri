import { useEffect, useState, useCallback } from 'react'
import { X } from 'lucide-react'
import { listen } from '@tauri-apps/api/event'

/** toast 上的操作按钮（如「撤销」）。点击后先移除该 toast，再执行 onClick */
export interface ToastAction {
  label: string
  onClick: () => void
}

export interface ToastData {
  message: string
  color?: string
  bg?: string
  duration?: number
  /** 后端 toast_show 事件字段 */
  level?: string
  /** 可选操作按钮；给了 action 时默认停留时间自动延长到 8000ms */
  action?: ToastAction
}

interface ToastItem {
  id: number
  message: string
  color?: string
  bg?: string
  action?: ToastAction
}

/** 默认停留时间 / 带操作按钮时的停留时间（用户需要时间点「撤销」） */
const DEFAULT_DURATION = 4000
const ACTION_DURATION = 8000

/** 屏幕上同时最多显示的 toast 数量，超出时淘汰最不可能被需要的那个 */
const MAX_TOASTS = 3

let toastId = 0

/** 按 level 映射边框色 */
function colorForLevel(level?: string): string | undefined {
  switch (level) {
    case 'success':
      return '#4ADE80'
    case 'error':
      return '#ef4444'
    case 'warn':
    case 'warning':
      return '#f59e0b'
    default:
      return undefined
  }
}

export default function GlobalToast() {
  const [toasts, setToasts] = useState<ToastItem[]>([])

  const removeToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const addToast = useCallback(
    (data: ToastData) => {
      if (!data?.message) return
      const id = ++toastId
      const color = data.color || colorForLevel(data.level)
      setToasts((prev) => {
        const next: ToastItem[] = [
          ...prev,
          { id, message: data.message, color, bg: data.bg, action: data.action },
        ]
        if (next.length <= MAX_TOASTS) return next
        // 超出上限时优先淘汰没有操作按钮的 toast：带「撤销」的那条若被挤掉，
        // 用户的删除就彻底不可恢复，而 8 秒停留时间本该是他唯一的挽救窗口
        const idx = next.findIndex((t) => !t.action)
        if (idx < 0) return next.slice(-MAX_TOASTS) // 全是 action 时才退回最老优先
        const copy = next.slice()
        copy.splice(idx, 1)
        return copy
      })
      // 带操作按钮的 toast 留更久；显式传了 duration 就按传入值
      const duration = data.duration ?? (data.action ? ACTION_DURATION : DEFAULT_DURATION)
      setTimeout(() => removeToast(id), duration)
    },
    [removeToast]
  )

  // DOM 自定义事件（前端 toastAPI / 插件）
  useEffect(() => {
    const handler = (e: Event) => {
      addToast((e as CustomEvent).detail as ToastData)
    }
    window.addEventListener('toast-show', handler)
    return () => window.removeEventListener('toast-show', handler)
  }, [addToast])

  // 后端 core/toast emit("toast_show")
  useEffect(() => {
    let unlisten: (() => void) | undefined
    let cancelled = false

    listen<ToastData>('toast_show', (event) => {
      if (!cancelled) addToast(event.payload)
    })
      .then((fn) => {
        if (cancelled) fn()
        else unlisten = fn
      })
      .catch((err) => {
        console.warn('[GlobalToast] 监听 toast_show 失败:', err)
      })

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [addToast])

  if (toasts.length === 0) return null

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[9999] flex flex-col gap-2 items-center">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className="glass-card flex items-center gap-3 px-4 py-2.5 min-w-[280px] max-w-[420px] animate-slide-up text-sm"
          style={{ borderColor: toast.color || 'var(--border-glass)' }}
        >
          <span className="flex-1 text-text-primary">{toast.message}</span>
          {toast.action && (
            <button
              className="shrink-0 whitespace-nowrap text-xs font-semibold transition-opacity hover:opacity-80"
              style={{ color: toast.color || 'var(--accent)' }}
              title={toast.action.label}
              // 必须先移除 toast 再执行回调：undo 会触发 state 更新，
              // 否则回调期间 toast 还挂在屏幕上，交互会重入
              onClick={() => {
                removeToast(toast.id)
                toast.action?.onClick()
              }}
            >
              {toast.action.label}
            </button>
          )}
          <button
            className="p-0.5 rounded hover:bg-bg-surface-hover transition-colors"
            onClick={() => removeToast(toast.id)}
            aria-label="关闭提示"
            title="关闭"
          >
            <X size={14} className="text-text-muted" />
          </button>
        </div>
      ))}
    </div>
  )
}
