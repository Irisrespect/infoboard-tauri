/**
 * 灵动岛 — 收缩态胶囊视图
 *
 * 始终可见的摘要视图，显示关键信息：
 * - idle 态：「🏝️ 灵动岛 · 待命中」
 * - 播放态：「▶️ 视频标题」
 */

import type { PillState, MediaSession } from './types'
import { Play, Smartphone } from 'lucide-react'

// ─── 收缩态视图组件 ───

interface PillCollapsedProps {
  /** 灵动岛状态 */
  state: PillState

  /** 当前媒体会话（播放态时有值） */
  media: MediaSession | null

}

/**
 * 收缩态胶囊视图
 *
 * 根据不同状态显示不同内容：
 * - idle: 空闲提示
 * - media-playing: 视频标题
 */
export function PillCollapsed({ state, media }: PillCollapsedProps) {
  // 根据状态渲染不同内容
  const renderContent = () => {
    switch (state) {
      case 'idle':
        return <IdleContent />

      case 'media-playing':
        return media ? <MediaContent media={media} /> : <IdleContent />

      default:
        return <IdleContent />
    }
  }

  return (
    <div
      className="inline-flex items-center gap-2 px-4 h-10 rounded-full transition-all duration-300 cursor-pointer select-none"
      style={{
        backgroundColor: 'var(--bg-glass)',
        backgroundImage: 'linear-gradient(rgba(0,0,0,0.35), rgba(0,0,0,0.35))',
        backdropFilter: 'blur(15px)',
        WebkitBackdropFilter: 'blur(15px)',
        border: '1px solid rgba(255,255,255,0.12)',
        width: 'calc(100% + 32px)',
        marginLeft: '-16px',
      }}
    >
      {renderContent()}
    </div>
  )
}

// ─── 内容组件 ───

/** 空闲态内容 */
function IdleContent() {
  return (
    <>
      <Smartphone size={16} color="#F0B8D4" />
      <span className="text-sm text-[#A1A1A6] font-medium">灵动岛 · 待命中</span>
    </>
  )
}

/** 播放态内容 */
function MediaContent({ media }: { media: MediaSession }) {
  // 截断标题，最多显示 20 个字符
  const truncatedTitle = media.title.length > 20 ? media.title.slice(0, 20) + '...' : media.title

  return (
    <>
      <Play size={14} color="#F0B8D4" />
      <span className="text-sm text-white font-medium truncate max-w-[200px]">
        {truncatedTitle}
      </span>
    </>
  )
}
