/**
 * 应用内日志检测台 UI（类似 DevTools Console）
 *
 * 快捷键：F12 切换显隐
 * 功能：级别筛选、搜索、清空、复制全部
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { X, Trash2, Copy, Search, Terminal } from 'lucide-react'
import {
  clearLogEntries,
  exportLogsText,
  formatLogLine,
  getLogEntries,
  getLogFilePath,
  subscribeLogs,
  type LogEntry,
  type LogLevel,
} from './appLog'
import { writeText } from './clipboard-bridge'

const LEVELS: Array<LogLevel | 'all'> = ['all', 'log', 'info', 'warn', 'error', 'debug']

function useLogEntries(): readonly LogEntry[] {
  return useSyncExternalStore(subscribeLogs, getLogEntries, getLogEntries)
}

function levelColor(level: LogLevel): string {
  switch (level) {
    case 'error':
      return '#f87171'
    case 'warn':
      return '#fbbf24'
    case 'info':
      return '#60a5fa'
    case 'debug':
      return '#a78bfa'
    default:
      return 'var(--text-secondary)'
  }
}

function levelBg(level: LogLevel): string {
  switch (level) {
    case 'error':
      return 'rgba(248, 113, 113, 0.08)'
    case 'warn':
      return 'rgba(251, 191, 36, 0.08)'
    default:
      return 'transparent'
  }
}

export interface LogConsoleProps {
  open: boolean
  onClose: () => void
}

export default function LogConsole({ open, onClose }: LogConsoleProps) {
  const entries = useLogEntries()
  const [filter, setFilter] = useState<LogLevel | 'all'>('all')
  const [query, setQuery] = useState('')
  const [autoScroll, setAutoScroll] = useState(true)
  const listRef = useRef<HTMLDivElement>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return entries.filter((e) => {
      if (filter !== 'all' && e.level !== filter) return false
      if (q && !e.message.toLowerCase().includes(q)) return false
      return true
    })
  }, [entries, filter, query])

  useEffect(() => {
    if (!open || !autoScroll || !listRef.current) return
    listRef.current.scrollTop = listRef.current.scrollHeight
  }, [filtered, open, autoScroll])

  const handleClear = useCallback(() => {
    clearLogEntries()
  }, [])

  const handleCopy = useCallback(async () => {
    const text = exportLogsText()
    if (!text) {
      console.warn('[LogConsole] 无日志可复制')
      return
    }
    try {
      await writeText(text)
      console.info(`[LogConsole] 已复制 ${text.split('\n').length} 行日志到剪贴板`)
      window.dispatchEvent(
        new CustomEvent('toast-show', {
          detail: { message: '日志已复制到剪贴板', color: '#4ADE80', duration: 2500 },
        })
      )
    } catch (e1) {
      try {
        await navigator.clipboard.writeText(text)
        console.info('[LogConsole] 已通过 navigator.clipboard 复制')
        window.dispatchEvent(
          new CustomEvent('toast-show', {
            detail: { message: '日志已复制到剪贴板', color: '#4ADE80', duration: 2500 },
          })
        )
      } catch (e2) {
        console.error('[LogConsole] 复制失败', e1, e2)
        window.dispatchEvent(
          new CustomEvent('toast-show', {
            detail: { message: '复制失败，请检查剪贴板权限', color: '#ef4444', duration: 3000 },
          })
        )
      }
    }
  }, [])

  if (!open) return null

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-[10000] flex flex-col border-t shadow-2xl"
      style={{
        height: 'min(42vh, 420px)',
        backgroundColor: 'var(--bg-surface)',
        borderColor: 'var(--border-subtle)',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      }}
      role="dialog"
      aria-label="日志检测台"
    >
      <div
        className="flex items-center gap-2 px-3 py-1.5 border-b shrink-0"
        style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-main)' }}
      >
        <Terminal size={14} style={{ color: 'var(--accent)' }} />
        <span className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
          日志台
        </span>
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
          {filtered.length}/{entries.length}
        </span>

        <div className="flex items-center gap-1 ml-2">
          {LEVELS.map((lv) => {
            const active = filter === lv
            return (
              <button
                key={lv}
                type="button"
                className="px-1.5 py-0.5 rounded text-[10px] uppercase transition-colors"
                style={{
                  color: active ? '#fff' : 'var(--text-muted)',
                  backgroundColor: active ? 'var(--accent)' : 'transparent',
                  border: active ? 'none' : '1px solid var(--border-subtle)',
                }}
                onClick={() => setFilter(lv)}
              >
                {lv}
              </button>
            )
          })}
        </div>

        <div
          className="flex items-center gap-1 ml-2 px-2 py-0.5 rounded flex-1 max-w-[220px]"
          style={{
            backgroundColor: 'var(--bg-surface-hover)',
            border: '1px solid var(--border-subtle)',
          }}
        >
          <Search size={12} style={{ color: 'var(--text-muted)' }} />
          <input
            className="flex-1 bg-transparent outline-none text-[11px]"
            style={{ color: 'var(--text-primary)' }}
            placeholder="过滤..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <label
          className="flex items-center gap-1 text-[10px] ml-1 cursor-pointer"
          style={{ color: 'var(--text-muted)' }}
        >
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
          />
          自动滚动
        </label>

        <button
          type="button"
          title="复制全部"
          aria-label="复制全部日志"
          className="p-1 rounded hover:opacity-80"
          style={{ color: 'var(--text-secondary)' }}
          onClick={handleCopy}
        >
          <Copy size={14} />
        </button>
        <button
          type="button"
          title="清空"
          aria-label="清空日志"
          className="p-1 rounded hover:opacity-80"
          style={{ color: 'var(--text-secondary)' }}
          onClick={handleClear}
        >
          <Trash2 size={14} />
        </button>
        <button
          type="button"
          title="关闭"
          aria-label="关闭日志台"
          className="p-1 rounded hover:opacity-80"
          style={{ color: 'var(--text-secondary)' }}
          onClick={onClose}
        >
          <X size={14} />
        </button>
      </div>

      <div ref={listRef} className="flex-1 overflow-auto px-1 py-1">
        {filtered.length === 0 ? (
          <div
            className="h-full flex items-center justify-center text-xs"
            style={{ color: 'var(--text-muted)' }}
          >
            暂无日志
          </div>
        ) : (
          filtered.map((e) => (
            <div
              key={e.id}
              className="px-2 py-0.5 text-[11px] leading-relaxed border-b break-all whitespace-pre-wrap"
              style={{
                color: levelColor(e.level),
                backgroundColor: levelBg(e.level),
                borderColor: 'var(--border-subtle)',
              }}
            >
              {formatLogLine(e)}
            </div>
          ))
        )}
      </div>

      <div
        className="px-3 py-1 text-[10px] border-t shrink-0 flex flex-col gap-0.5"
        style={{ color: 'var(--text-muted)', borderColor: 'var(--border-subtle)' }}
      >
        <span>F12 开关 · 打包后也可用 · 最多保留 800 条 · WEB/RUST 双通道</span>
        {getLogFilePath() ? (
          <span className="truncate" title={getLogFilePath() || ''}>
            文件: {getLogFilePath()}
          </span>
        ) : null}
      </div>
    </div>
  )
}
