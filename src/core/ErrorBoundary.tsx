/**
 * 错误边界
 *
 * 全仓原先没有任何 ErrorBoundary：任何组件抛错都会让整窗白屏（只剩透明窗口，
 * 用户连日志都打不开）。这里提供两级：
 *
 * 1. 应用级（main.tsx）：兜底整个界面，显示错误 + 「重新加载」+「打开日志台」
 * 2. 插件级（InfoSection / ToolExpandPanel / PluginHost）：单个插件崩溃只影响
 *    自己那张卡片，其余插件照常工作
 *
 * `getDerivedStateFromError` 用到的转换逻辑抽成纯函数，便于单测。
 */

import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react'

/** 把 catch 到的任意值统一成 Error（throw 字符串/对象/undefined 都很常见） */
export function toError(value: unknown): Error {
  if (value instanceof Error) return value
  if (typeof value === 'string') return new Error(value)
  if (value && typeof value === 'object') {
    const maybe = value as { message?: unknown }
    if (typeof maybe.message === 'string' && maybe.message) return new Error(maybe.message)
    try {
      return new Error(JSON.stringify(value))
    } catch {
      return new Error(String(value))
    }
  }
  return new Error(value === undefined ? '未知错误' : String(value))
}

/** 供界面展示的标题 / 详情（纯函数） */
export function describeError(error: Error): { title: string; detail: string } {
  const title = error.message?.trim() || error.name || '未知错误'
  const detail = (error.stack || '').split('\n').slice(0, 6).join('\n').trim()
  return { title, detail }
}

/** 打开应用内日志台（main.tsx 里监听该事件） */
function openLogConsole(): void {
  window.dispatchEvent(new CustomEvent('log-console-open'))
}

interface ErrorBoundaryProps {
  children: ReactNode
  /** 出错的来源名称（如插件名），用于提示文案 */
  label?: string
  /** 应用级兜底样式（整块）或插件级（内嵌小卡片） */
  variant?: 'app' | 'plugin'
  onError?: (error: Error, info: ErrorInfo) => void
}

interface ErrorBoundaryState {
  error: Error | null
  /** 重置时自增，用于强制子组件重新挂载 */
  generation: number
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, generation: 0 }

  static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    return { error: toError(error) }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    const err = toError(error)
    // 打到控制台（进应用内日志台 + app.log），别再让错误无影无踪
    console.error(`[ErrorBoundary] ${this.props.label || '界面'} 渲染出错:`, err, info.componentStack)
    this.props.onError?.(err, info)
  }

  private reset = (): void => {
    this.setState((prev) => ({ error: null, generation: prev.generation + 1 }))
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) {
      return <Fragment key={this.state.generation}>{this.props.children}</Fragment>
    }

    const { title, detail } = describeError(error)

    if (this.props.variant === 'plugin') {
      return (
        <div
          className="rounded-lg px-3 py-2 my-1 text-xs"
          style={{
            border: '1px solid #fecaca',
            backgroundColor: 'rgba(239,68,68,0.08)',
            color: 'var(--text-primary)',
          }}
          data-error-boundary="plugin"
        >
          <div className="font-medium" style={{ color: '#ef4444' }}>
            ⚠️ 插件「{this.props.label || '未知'}」出错了
          </div>
          <div className="mt-1 break-all" style={{ color: 'var(--text-muted)' }}>
            {title}
          </div>
          <button
            className="mt-2 px-2 py-0.5 rounded text-[11px]"
            style={{ border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}
            onClick={(e) => {
              e.stopPropagation()
              this.reset()
            }}
          >
            重试
          </button>
        </div>
      )
    }

    return (
      <div
        className="flex flex-col items-center justify-center gap-3 p-6 text-center"
        style={{ minHeight: '100vh', color: 'var(--text-primary)' }}
        data-error-boundary="app"
      >
        <div className="text-lg font-semibold" style={{ color: '#ef4444' }}>
          InfoBoard 界面出错了
        </div>
        <div className="text-sm break-all max-w-[520px]">{title}</div>
        {detail && (
          <pre
            className="text-[10px] text-left max-w-[560px] max-h-[180px] overflow-auto p-2 rounded"
            style={{ backgroundColor: 'var(--bg-surface)', color: 'var(--text-muted)' }}
          >
            {detail}
          </pre>
        )}
        <div className="flex gap-2 mt-1">
          <button
            className="px-3 py-1.5 text-xs rounded-md"
            style={{ backgroundColor: 'var(--accent)', color: '#fff' }}
            onClick={() => window.location.reload()}
          >
            重新加载
          </button>
          <button
            className="px-3 py-1.5 text-xs rounded-md"
            style={{ border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}
            onClick={openLogConsole}
          >
            打开日志台
          </button>
        </div>
      </div>
    )
  }
}
