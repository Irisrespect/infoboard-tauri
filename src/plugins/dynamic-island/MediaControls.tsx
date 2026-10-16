/**
 * 媒体控制组件
 *
 * 显示当前播放的媒体信息和控制按钮
 * - 标题和作者
 * - 播放状态
 * - 控制按钮（播放/暂停、上一个、下一个）
 */

import type { MediaSession, PlaybackStatus } from './types'
import { formatPlaybackStatus } from './useMediaControl'
import { Play, Pause, SkipBack, SkipForward } from 'lucide-react'

// ─── 来源应用图标配置 ───

interface IconProps {
  size?: number
  className?: string
}

/** 各媒体应用的图标映射 */
const SOURCE_APP_ICONS: Record<string, { name: string; icon: string }> = {
  'bilibili.exe': { name: 'Bilibili', icon: 'Bilibili' },
  '哔哩哔哩.exe': { name: 'Bilibili', icon: 'Bilibili' },
  'spotify.exe': { name: 'Spotify', icon: '🎵' },
  'chrome.exe': { name: 'Chrome', icon: '🌐' },
  'msedge.exe': { name: 'Edge', icon: '🌐' },
  'firefox.exe': { name: 'Firefox', icon: '🌐' },
}

/** Bilibili 小电视图标（内联 base64，避免打包后路径问题） */
const BILIBILI_ICON =
  'data:image/png;base64,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'

function BilibiliIcon({ size = 48, className }: IconProps) {
  return (
    <div
      className={`flex items-center justify-center rounded-lg overflow-hidden ${className || ''}`}
      style={{
        width: size,
        height: size,
        backgroundColor: 'transparent',
      }}
    >
      <img
        src={BILIBILI_ICON}
        alt="Bilibili"
        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
      />
    </div>
  )
}

/** 根据 sourceAppId 获取图标组件 */
function SourceAppIcon({ sourceAppId, size = 48 }: { sourceAppId?: string; size?: number }) {
  // 通过 sourceAppId 匹配已知应用
  if (sourceAppId) {
    const appKey = Object.keys(SOURCE_APP_ICONS).find(
      (key) => sourceAppId.toLowerCase().includes(key.replace('.exe', '')) || sourceAppId === key
    )
    const app = appKey ? SOURCE_APP_ICONS[appKey] : null

    if (app?.icon === 'Bilibili') {
      return <BilibiliIcon size={size} />
    }
    if (app) {
      return (
        <div
          className="w-12 h-12 rounded-lg flex items-center justify-center shrink-0 text-xl"
          style={{ backgroundColor: 'var(--border-subtle)' }}
          title={app.name}
        >
          {app.icon}
        </div>
      )
    }
  }

  // 未知来源 → 通用媒体图标
  return (
    <div
      className="w-12 h-12 rounded-lg flex items-center justify-center shrink-0 text-xl"
      style={{ backgroundColor: 'var(--border-subtle)' }}
      title="媒体播放"
    >
      🎬
    </div>
  )
}

// ─── MediaControls 组件 ───

interface MediaControlsProps {
  /** 媒体会话信息 */
  media: MediaSession

  /** 发送控制命令 */
  onSendCommand: (command: 'play' | 'pause' | 'toggle' | 'next' | 'previous') => Promise<boolean>
}

/**
 * 媒体控制组件
 */
export function MediaControls({ media, onSendCommand }: MediaControlsProps) {
  const isPlaying = media.playbackStatus === 'playing'

  const handlePlayPause = async () => {
    await onSendCommand('toggle')
  }

  const handlePrevious = async () => {
    await onSendCommand('previous')
  }

  const handleNext = async () => {
    await onSendCommand('next')
  }

  return (
    <div
      className="flex flex-col gap-3 p-3 rounded-lg"
      style={{ backgroundColor: 'var(--bg-main)' }}
    >
      {/* 媒体信息 */}
      <div className="flex items-center gap-3">
        {/* 缩略图或占位图标 */}
        {media.thumbnail ? (
          <img
            src={media.thumbnail}
            alt={media.title}
            className="w-12 h-12 rounded-lg object-cover shrink-0"
            referrerPolicy="no-referrer"
          />
        ) : (
          <SourceAppIcon sourceAppId={media.sourceAppId} size={48} />
        )}

        {/* 标题和作者 */}
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
            {media.title}
          </div>
          <div className="flex items-center gap-1.5">
            {/* UP主头像（B站来源时显示） */}
            {media.ownerAvatar && (
              <img
                src={media.ownerAvatar}
                alt={media.artist}
                className="w-4 h-4 rounded-full object-cover"
                referrerPolicy="no-referrer"
              />
            )}
            <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {media.artist || formatPlaybackStatus(media.playbackStatus as PlaybackStatus)}
            </div>
          </div>
        </div>
      </div>

      {/* 控制按钮 */}
      <div className="flex items-center justify-center gap-4">
        {/* 上一个 */}
        <button
          className="w-9 h-9 flex items-center justify-center rounded-full transition-colors hover:opacity-80"
          style={{
            backgroundColor: 'rgba(25,15,35,0.5)',
            color: 'rgba(255,255,255,0.7)',
          }}
          onClick={(e) => {
            e.stopPropagation()
            handlePrevious()
          }}
          title="上一个"
          aria-label="上一个"
        >
          <SkipBack size={16} />
        </button>

        {/* 播放/暂停 */}
        <button
          className="w-11 h-11 flex items-center justify-center rounded-full transition-colors hover:opacity-80"
          style={{
            backgroundColor: '#F0B8D4',
            color: '#1A0F23',
          }}
          onClick={(e) => {
            e.stopPropagation()
            handlePlayPause()
          }}
          title={isPlaying ? '暂停' : '播放'}
          aria-label={isPlaying ? '暂停' : '播放'}
        >
          {isPlaying ? <Pause size={20} /> : <Play size={20} />}
        </button>

        {/* 下一个 */}
        <button
          className="w-9 h-9 flex items-center justify-center rounded-full transition-colors hover:opacity-80"
          style={{
            backgroundColor: 'rgba(25,15,35,0.5)',
            color: 'rgba(255,255,255,0.7)',
          }}
          onClick={(e) => {
            e.stopPropagation()
            handleNext()
          }}
          title="下一个"
          aria-label="下一个"
        >
          <SkipForward size={16} />
        </button>
      </div>
    </div>
  )
}
