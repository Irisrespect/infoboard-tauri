/**
 * 工具展开面板
 *
 * 点击工具图标后展开的面板，加载对应插件的 Component
 */

import { useRef, useEffect } from 'react'
import { ErrorBoundary } from '../core/ErrorBoundary'
import type { InfoBoardPlugin } from '../core/types'
import { SVG_ICONS, isEmoji } from './ToolSection'

/**
 * 工具展开面板属性
 */
interface ToolExpandPanelProps {
  /** 要显示的插件 */
  plugin: InfoBoardPlugin

  /** 关闭回调 */
  onClose: () => void
}

/**
 * 工具展开面板组件
 *
 * @example
 * ```tsx
 * <ToolExpandPanel plugin={notesPlugin} onClose={() => setExpanded(null)} />
 * ```
 */
export function ToolExpandPanel({ plugin, onClose }: ToolExpandPanelProps) {
  const { Component, manifest } = plugin
  const panelRef = useRef<HTMLDivElement>(null)

  // 点击外部关闭
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) {
        // 检查点击的是否是工具图标（避免立即关闭）
        const target = event.target as HTMLElement
        const isToolIcon = target.closest('[data-plugin-id]')
        if (!isToolIcon) {
          onClose()
        }
      }
    }

    // 延迟添加监听，避免点击图标时立即触发
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside)
    }, 100)

    return () => {
      clearTimeout(timer)
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [onClose])

  // ESC 键关闭
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return (
    <div
      ref={panelRef}
      className="flex-1 rounded-glass glass-card overflow-hidden animate-slide-up"
      data-panel-id={manifest.id}
    >
      {/* 面板头部 */}
      <PanelHeader manifest={manifest} onClose={onClose} />

      {/* 面板内容 */}
      <div className="flex-1 overflow-auto" style={{ maxHeight: 'calc(100vh - 300px)' }}>
        {/* 插件级兜底：面板里的插件崩溃不应带走整个面板 */}
        <ErrorBoundary variant="plugin" label={manifest.name}>
          <Component manifest={manifest} expanded={true} />
        </ErrorBoundary>
      </div>
    </div>
  )
}

/**
 * 面板头部属性
 */
interface PanelHeaderProps {
  manifest: InfoBoardPlugin['manifest']
  onClose: () => void
}

/**
 * 面板头部组件
 */
function PanelHeader({ manifest, onClose }: PanelHeaderProps) {
  return (
    <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
      <div className="flex items-center gap-2">
        {/* 图标 */}
        {isEmoji(manifest.icon) ? (
          <span className="text-lg" style={{ color: manifest.color }}>
            {manifest.icon}
          </span>
        ) : SVG_ICONS[manifest.icon] ? (
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            style={{ stroke: manifest.color }}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {SVG_ICONS[manifest.icon]}
          </svg>
        ) : (
          <span className="text-lg text-text-muted">{manifest.icon}</span>
        )}

        {/* 名称 */}
        <span className="text-sm font-semibold text-text-primary">{manifest.name}</span>
      </div>

      {/* 关闭按钮 */}
      <button
        className="w-6 h-6 flex items-center justify-center rounded-full hover:bg-bg-surface-hover transition-colors"
        onClick={onClose}
        title="关闭"
      >
        <svg
          className="w-4 h-4 text-text-muted"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M6 18L18 6M6 6l12 12"
          />
        </svg>
      </button>
    </div>
  )
}
