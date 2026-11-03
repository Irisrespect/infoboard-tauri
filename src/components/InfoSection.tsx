/**
 * 信息区容器
 *
 * 负责：
 * 1. 纵向排列信息区插件（上下布局）
 * 2. 卡片展开/折叠交互（同时只能展开一张）
 * 3. 灵动岛始终排第一，空闲时隐藏，有内容时带动画弹出
 */

import { useState, useCallback, useEffect } from 'react'
import { usePlugins } from '../core/PluginHost'
import { ErrorBoundary } from '../core/ErrorBoundary'
import type { InfoBoardPlugin, PluginComponentProps } from '../core/types'
import { eventBus } from '../core/eventBus'

/** 灵动岛插件 ID */
const ISLAND_ID = 'dynamic-island'

/**
 * InfoCard 额外注入给插件的可选 props
 *
 * 核心的 `PluginComponentProps` 只声明了 manifest / expanded，但"点头部折叠"
 * 需要插件拿到 onToggle。插件把它声明成**可选**扩展 props 即可，
 * 仍然是 `ComponentType<PluginComponentProps>` 的合法实现。
 */
type PluginCardProps = PluginComponentProps & { onToggle?: () => void }

export function InfoSection() {
  const infoPlugins = usePlugins('info')
  const [expandedPluginId, setExpandedPluginId] = useState<string | null>(null)
  const [islandVisible, setIslandVisible] = useState(false)
  const [islandInert, setIslandInert] = useState(true)

  // 监听灵动岛的可见性事件
  useEffect(() => {
    const cleanup = eventBus.on(
      'island:visibility',
      (event) => {
        const payload = event.payload as { visible?: boolean } | undefined
        const visible = payload?.visible ?? false
        setIslandVisible(visible)
      },
      'InfoSection'
    )
    return cleanup
  }, [])

  // 同步 inert 与展开/收起动画 timing
  // 收起时立即锁定 → 展开时延迟解锁（等动画启动后再允许交互）
  useEffect(() => {
    if (!islandVisible) {
      setIslandInert(true)
    } else {
      const t = setTimeout(() => setIslandInert(false), 100)
      return () => clearTimeout(t)
    }
  }, [islandVisible])

  const togglePlugin = useCallback((pluginId: string) => {
    setExpandedPluginId((prev) => (prev === pluginId ? null : pluginId))
  }, [])

  if (infoPlugins.length === 0) {
    return (
      <section className="flex flex-col gap-3">
        <SectionLabel />
        <div className="flex gap-3">
          <EmptyCard message="暂无信息插件" />
        </div>
      </section>
    )
  }

  // 灵动岛始终排第一
  const sortedPlugins = [...infoPlugins].sort((a, b) => {
    if (a.manifest.id === ISLAND_ID) return -1
    if (b.manifest.id === ISLAND_ID) return 1
    return 0
  })

  return (
    <section className="flex flex-col gap-3">
      <SectionLabel />
      <div className="flex flex-col gap-3">
        {sortedPlugins.map((plugin) => {
          const isIsland = plugin.manifest.id === ISLAND_ID

          // 灵动岛：带可见性动画
          if (isIsland) {
            return (
              <div
                key={plugin.manifest.id}
                inert={islandInert}
                className="transition-[grid-template-rows] duration-500 ease-[cubic-bezier(0.4,0,0.2,1)]"
                style={{
                  display: 'grid',
                  gridTemplateRows: islandVisible ? '1fr' : '0fr',
                  marginBottom: '-10px',
                }}
              >
                <div className="overflow-hidden min-h-0">
                  <InfoCard
                    plugin={plugin}
                    isExpanded={expandedPluginId === plugin.manifest.id}
                    onToggle={() => togglePlugin(plugin.manifest.id)}
                  />
                </div>
              </div>
            )
          }

          // 其他插件：正常渲染
          return (
            <InfoCard
              key={plugin.manifest.id}
              plugin={plugin}
              isExpanded={expandedPluginId === plugin.manifest.id}
              onToggle={() => togglePlugin(plugin.manifest.id)}
            />
          )
        })}
      </div>
    </section>
  )
}

/**
 * 区域标签
 */
function SectionLabel() {
  return (
    <span className="text-[11px] font-semibold text-text-muted tracking-widest uppercase">
      信息区
    </span>
  )
}

/**
 * 信息卡片属性
 */
interface InfoCardProps {
  plugin: InfoBoardPlugin
  isExpanded: boolean
  onToggle: () => void
}

/**
 * 信息卡片组件
 */
function InfoCard({ plugin, isExpanded, onToggle }: InfoCardProps) {
  const { Component, manifest } = plugin
  const isIsland = manifest.id === 'dynamic-island'

  // 展开面板的 id 约定：插件内部把展开容器标成 `${manifest.id}-panel`
  const panelId = `${manifest.id}-panel`
  // aria-controls 必须指向真实存在的元素，没提供面板容器的插件就不设（避免无效引用）
  // 面板可能在插件数据加载完成后才出现，所以展开状态变化时再确认一次
  const [hasPanel, setHasPanel] = useState(false)
  useEffect(() => {
    setHasPanel(document.getElementById(panelId) !== null)
  }, [panelId, isExpanded])

  // 组件只声明了 PluginComponentProps，onToggle 是可选扩展 → 收敛到更宽的类型再传
  const PluginComponent: React.ComponentType<PluginCardProps> = Component

  const cardClassName = [
    isIsland ? 'rounded-card' : 'rounded-card glass-card',
    'cursor-pointer overflow-hidden',
    'transition-[flex,opacity] duration-500 ease-[cubic-bezier(0.4,0,0.2,1)]',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      className={cardClassName}
      onClick={onToggle}
      role="button"
      tabIndex={0}
      aria-expanded={isExpanded}
      aria-controls={hasPanel ? panelId : undefined}
      onKeyDown={(e) => {
        // 焦点在内部控件上时，Enter/Space 归控件自己处理：
        // 否则 preventDefault 会把内部 <button> 的合成 click 掐掉，
        // 表现为"在「已完成」筛选上按 Enter 只会折叠卡片"。
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onToggle()
        }
      }}
      data-plugin-id={manifest.id}
      data-expanded={isExpanded}
    >
      <div className="p-4">
        {/* 插件级兜底：单个插件崩溃不该影响其它卡片 */}
        <ErrorBoundary variant="plugin" label={manifest.name}>
          <PluginComponent manifest={manifest} expanded={isExpanded} onToggle={onToggle} />
        </ErrorBoundary>
      </div>
    </div>
  )
}

/**
 * 空状态卡片
 */
function EmptyCard({ message }: { message: string }) {
  return (
    <div className="flex-1 h-[150px] rounded-card bg-bg-surface border border-border-subtle flex items-center justify-center text-text-muted text-sm">
      {message}
    </div>
  )
}
