/**
 * 自定义标题栏组件
 *
 * Pencil 设计风格：
 * - 左侧：应用标题
 * - 右侧：最小化/关闭（Lucide 图标）
 * - 支持拖拽移动窗口
 */

import { useState, useEffect } from 'react'

export function TitleBar() {
  const [isMaximized, setIsMaximized] = useState(false)

  useEffect(() => {
    if (!window.electronAPI) return
    window.electronAPI.isMaximized().then(setIsMaximized)
  }, [])

  const handleMinimize = async () => {
    console.log('[窗口] 点击最小化按钮')
    if (window.electronAPI) await window.electronAPI.minimize()
  }

  const handleMaximize = async () => {
    console.log('[窗口] 点击最大化/还原按钮')
    if (window.electronAPI) {
      await window.electronAPI.maximize()
      setIsMaximized((prev) => !prev)
    }
  }

  const handleClose = async () => {
    console.log('[窗口] 点击关闭按钮')
    if (window.electronAPI) await window.electronAPI.close()
  }

  return (
    <header
      className="h-10 flex items-center justify-between px-4 select-none drag-region"
      style={{
        borderBottom: '1px solid var(--border-subtle)',
      }}
    >
      {/* 左侧：图标 */}
      <div className="flex items-center no-drag-region">
        {/* 应用图标（Lucide layout-dashboard） */}
        <svg
          className="w-4 h-4"
          style={{ color: 'var(--accent)' }}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
        >
          <rect x="3" y="3" width="7" height="9" rx="1" />
          <rect x="14" y="3" width="7" height="5" rx="1" />
          <rect x="14" y="12" width="7" height="9" rx="1" />
          <rect x="3" y="16" width="7" height="5" rx="1" />
        </svg>
      </div>

      {/* 右侧：控制按钮（Pencil 风格 Lucide 图标） */}
      <div className="flex items-center gap-1 no-drag-region">
        {/* 日志台 */}
        <button
          className="w-6 h-6 flex items-center justify-center rounded hover:bg-bg-surface-hover transition-colors"
          onClick={() => window.dispatchEvent(new CustomEvent('log-console-toggle'))}
          title="日志台 (F12)"
          aria-label="打开日志台"
        >
          <svg
            className="w-3.5 h-3.5 text-text-muted"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
          >
            <path d="M4 17l6-6-6-6" />
            <path d="M12 19h8" />
          </svg>
        </button>

        {/* 最小化 */}

        <button
          className="w-6 h-6 flex items-center justify-center rounded hover:bg-bg-surface-hover transition-colors"
          onClick={handleMinimize}
          title="最小化"
          aria-label="最小化窗口"
        >
          <svg
            className="w-3.5 h-3.5 text-text-muted"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
          >
            <path d="M5 12h14" />
          </svg>
        </button>

        {/* 最大化/还原 */}
        <button
          className="w-6 h-6 flex items-center justify-center rounded hover:bg-bg-surface-hover transition-colors"
          onClick={handleMaximize}
          title={isMaximized ? '还原' : '最大化'}
          aria-label={isMaximized ? '还原窗口' : '最大化窗口'}
        >
          {isMaximized ? (
            <svg
              className="w-3.5 h-3.5 text-text-muted"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
            >
              <path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3" />
            </svg>
          ) : (
            <svg
              className="w-3.5 h-3.5 text-text-muted"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
            >
              <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
            </svg>
          )}
        </button>

        {/* 关闭 */}
        <button
          className="w-6 h-6 flex items-center justify-center rounded hover:bg-red-500 hover:text-white transition-colors group"
          onClick={handleClose}
          title="关闭"
          aria-label="隐藏到托盘"
        >
          <svg
            className="w-3.5 h-3.5 text-text-muted group-hover:text-white"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
          >
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
    </header>
  )
}
