import { useEffect, useState, useCallback } from 'react'
import { X } from 'lucide-react'
import { listen } from '@tauri-apps/api/event'

interface ToastData {
  message: string
  color?: string
  bg?: string
  duration?: number
  /** 后端 toast_show 事件字段 */
  level?: string
}

interface ToastItem {
  id: number
  message: string
  color?: string
  bg?: string
}

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
        const next = [...prev, { id, message: data.message, color, bg: data.bg }]
        return next.length > 3 ? next.slice(-3) : next
      })
      setTimeout(() => removeToast(id), data.duration || 4000)
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
