/**
 * 灵动岛插件 — 主组件
 *
 * 负责：
 * 1. 集成真实 SMTC 媒体数据（Phase 4b）
 * 2. 渲染收缩态和展开态
 * 3. 点击展开/收缩交互（由 InfoSection 控制）
 *
 * 数据源：
 * - 媒体数据：通过 useMediaControl hook 获取真实 SMTC 数据
 * - Mock 数据：仅开发环境可用，用于测试 UI
 */

import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import type { PluginComponentProps } from '../../core/types'
import type { PillState, MediaSession } from './types'
import { useMediaControl } from './useMediaControl'
import { PillCollapsed } from './PillCollapsed'
import { MediaControls } from './MediaControls'
import { useMusicPlayerBridge } from './useMusicPlayerBridge'
import { LyricsView } from './LyricsView'
import { eventBus } from '../../core/eventBus'

// ─── Mock 数据（模块级，避免每次渲染重建） ───

const MOCK_MEDIA: MediaSession = {
  title: '【4K】赛博朋克2077 全剧情电影',
  artist: '影视飓风',
  playbackStatus: 'playing',
  sourceAppId: 'bilibili.exe',
  thumbnail: '',
  ownerAvatar: '',
}

/**
 * 灵动岛主组件
 */
export function DynamicIsland({ manifest, expanded }: PluginComponentProps) {
  // ─── 真实媒体数据（SMTC） ───

  const {
    currentMedia: smtcMedia,
    isLoading: isMediaLoading,
    error: mediaError,
    sendCommand,
  } = useMediaControl()

  // ─── MusicPlayer 桥接 ───

  const mpState = useMusicPlayerBridge()

  const mpCurrentIndex = useMemo(() => {
    if (!mpState.isOnline || mpState.lyrics.length === 0) return -1
    const adjustedTime = mpState.position + (mpState.lyricsOffset || 0)
    const isSynced = mpState.lyrics.some((l) => l.time > 0)
    if (!isSynced) return -1
    let idx = -1
    for (let i = 0; i < mpState.lyrics.length; i++) {
      if (mpState.lyrics[i].time <= adjustedTime) idx = i
      else break
    }
    return idx
  }, [mpState.lyrics, mpState.position, mpState.lyricsOffset])

  // ─── Mock 数据（仅开发环境） ───

  const [mockMedia, setMockMedia] = useState<MediaSession | null>(null)
  const [useMockData, setUseMockData] = useState(false)

  // ─── 计算当前使用的数据源 ───

  // 优先使用 mock 数据（开发环境测试），否则使用真实 SMTC 数据
  const smtcOrMock = useMockData ? mockMedia : smtcMedia

  // 当 SMTC 无数据但 MusicPlayer 在线时，用 MusicPlayer 数据构造合成媒体会话
  const currentMedia: MediaSession | null = useMemo(() => {
    if (smtcOrMock) return smtcOrMock
    if (
      mpState.isOnline &&
      (mpState.playbackState === 'playing' || mpState.playbackState === 'paused')
    ) {
      return {
        title: mpState.title,
        artist: mpState.artist,
        thumbnail: mpState.thumbnail || '',
        playbackStatus: mpState.playbackState,
        sourceAppId: 'musicplayer.exe',
      }
    }
    return null
  }, [
    smtcOrMock,
    mpState.isOnline,
    mpState.playbackState,
    mpState.title,
    mpState.artist,
    mpState.thumbnail,
  ])

  // 计算 pill 状态
  const pillState = useMemo<PillState>(
    () => (currentMedia != null ? 'media-playing' : 'idle'),
    [currentMedia]
  )

  // 有内容时通知 InfoSection 显示灵动岛，空闲时隐藏（开发模式下始终可见以便调试）
  const isDev = import.meta.env.DEV
  const hasContent = isDev || pillState !== 'idle'
  useEffect(() => {
    eventBus.emit('island:visibility', { visible: hasContent }, 'dynamic-island')
  }, [hasContent, isDev])

  // ─── Mock 数据方法（仅开发环境） ───

  const loadMockMedia = useCallback(() => {
    setMockMedia(MOCK_MEDIA)
    setUseMockData(true)
  }, [])

  const clearMockData = useCallback(() => {
    setMockMedia(null)
    setUseMockData(false)
  }, [])

  // ─── 控制命令路由（MusicPlayer 在线时走 HTTP，否则 SMTC） ───

  const handleSendCommand = useCallback(
    async (command: 'play' | 'pause' | 'toggle' | 'next' | 'previous') => {
      if (mpState.isOnline) {
        try {
          await fetch('http://127.0.0.1:17831/command', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command }),
            signal: AbortSignal.timeout(1500),
          })
          return true
        } catch {
          return false
        }
      }
      return sendCommand(command)
    },
    [mpState.isOnline, sendCommand]
  )

  // ─── 渲染 ───

  return (
    <div className="relative">
      {/* 收缩摘要：始终可见 */}
      <PillCollapsed
        state={pillState}
        media={currentMedia}
      />

      {/* 展开详情：grid 行高动画 0fr ↔ 1fr */}
      <div
        className="transition-[grid-template-rows] duration-500 ease-[cubic-bezier(0.4,0,0.2,1)]"
        style={{
          display: 'grid',
          gridTemplateRows: expanded ? '1fr' : '0fr',
        }}
      >
        <div className="overflow-hidden min-h-0">
          <ExpandedView
            pillState={pillState}
            currentMedia={currentMedia}
            isMediaLoading={isMediaLoading}
            mediaError={mediaError}
            mpState={mpState}
            mpCurrentIndex={mpCurrentIndex}
            isDev={isDev}
            useMockData={useMockData}
            onSendCommand={handleSendCommand}
            onLoadMockMedia={loadMockMedia}
            onClearMockData={clearMockData}
          />
        </div>
      </div>
    </div>
  )
}

// ─── 展开视图 ───

interface ExpandedViewProps {
  pillState: PillState
  currentMedia: MediaSession | null
  isMediaLoading: boolean
  mediaError: string | null
  mpState: {
    isOnline: boolean
    playbackState: string
    title: string
    artist: string
    thumbnail: string
    position: number
    duration: number
    lyrics: Array<{ time: number; text: string }>
    lyricsOffset: number
  }
  mpCurrentIndex: number
  isDev: boolean
  useMockData: boolean
  onSendCommand: (command: 'play' | 'pause' | 'toggle' | 'next' | 'previous') => Promise<boolean>
  onLoadMockMedia: () => void
  onClearMockData: () => void
}

/**
 * 展开视图
 */
function ExpandedView({
  pillState,
  currentMedia,
  isMediaLoading,
  mediaError,
  mpState,
  mpCurrentIndex,
  isDev,
  useMockData,
  onSendCommand,
  onLoadMockMedia,
  onClearMockData,
}: ExpandedViewProps) {
  return (
    <div className="flex flex-col gap-3 mt-3">
      {/* 媒体控制区 */}
      {currentMedia && <MediaControls media={currentMedia} onSendCommand={onSendCommand} />}

      {/* 播放进度条 */}
      {mpState.isOnline && mpState.duration > 0 && (
        <div className="px-3 py-1">
          <div className="w-full h-1 rounded-full" style={{ background: 'rgba(255,255,255,0.1)' }}>
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.min(100, Math.max(0, (mpState.position / mpState.duration) * 100))}%`,
                background: 'var(--accent)',
              }}
            />
          </div>
          <div className="flex justify-between mt-1">
            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
              {fmt(mpState.position)}
            </span>
            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
              {fmt(mpState.duration)}
            </span>
          </div>
        </div>
      )}

      {/* MusicPlayer 歌词区 */}
      {mpState.isOnline && mpState.lyrics.length > 0 && (
        <div className="p-2 rounded-lg" style={{ backgroundColor: 'var(--bg-surface)' }}>
          <div
            className="text-[10px] mb-1.5 flex items-center justify-between"
            style={{ color: 'var(--text-muted)' }}
          >
            <span>
              {mpState.title} — {mpState.artist}
            </span>
            <span>🎵 MusicPlayer</span>
          </div>
          <LyricsView lyrics={mpState.lyrics} currentIndex={mpCurrentIndex} loading={false} />
        </div>
      )}

      {/* MusicPlayer 在线但无歌词 */}
      {mpState.isOnline && mpState.lyrics.length === 0 && (
        <div
          className="text-xs text-center py-2 px-3 rounded-lg"
          style={{
            backgroundColor: 'transparent',
            color: 'var(--text-muted)',
          }}
        >
          🎵 {mpState.title} — {mpState.artist}（暂无歌词）
        </div>
      )}

      {/* 加载状态 */}
      {isMediaLoading && !useMockData && (
        <div
          className="text-xs text-center py-2 px-3 rounded-lg"
          style={{
            backgroundColor: 'transparent',
            color: 'var(--text-muted)',
          }}
        >
          正在检测媒体播放...
        </div>
      )}

      {/* 错误状态 */}
      {mediaError && !useMockData && (
        <div
          className="text-xs text-center py-2 px-3 rounded-lg"
          style={{
            backgroundColor: 'transparent',
            color: 'var(--text-muted)',
          }}
        >
          ⚠️ {mediaError}
        </div>
      )}

      {/* 数据源指示器（调试用） */}
      {isDev && useMockData && (
        <div
          className="text-[10px] text-center py-1 px-2 rounded"
          style={{
            backgroundColor: 'transparent',
            color: 'var(--text-muted)',
          }}
        >
          🔄 使用 Mock 数据
        </div>
      )}

      {/* 开发工具：Mock 数据控制（仅开发环境显示） */}
      {isDev && (
        <div
          className="flex flex-wrap gap-2 justify-center py-2 px-3 rounded-lg border border-dashed"
          style={{
            borderColor: 'var(--border-subtle)',
            backgroundColor: 'var(--bg-surface)',
          }}
        >
          <span
            className="text-[10px] w-full text-center mb-1"
            style={{ color: 'var(--text-muted)' }}
          >
            🔄 开发工具：模拟数据
          </span>

          <button
            className="text-xs px-3 py-1 rounded-md transition-colors hover:opacity-80"
            style={{
              backgroundColor: 'transparent',
              color: 'var(--text-primary)',
              border: '1px solid var(--border-subtle)',
            }}
            onClick={(e) => {
              e.stopPropagation()
              onLoadMockMedia()
            }}
          >
            🎬 模拟媒体
          </button>

          <button
            className="text-xs px-3 py-1 rounded-md transition-colors hover:opacity-80"
            style={{
              backgroundColor: useMockData ? '#FEE2E2' : 'var(--bg-main)',
              color: useMockData ? '#DC2626' : 'var(--text-primary)',
              border: `1px solid ${useMockData ? '#FECACA' : 'var(--border-subtle)'}`,
            }}
            onClick={(e) => {
              e.stopPropagation()
              onClearMockData()
            }}
          >
            {useMockData ? '🗑️ 清除 Mock' : '🔄 使用真实数据'}
          </button>
        </div>
      )}

      {/* 空状态提示 */}
      {pillState === 'idle' && !isDev && !isMediaLoading && (
        <div className="text-center py-4">
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            打开 Bilibili 播放视频，这里会自动显示
          </span>
        </div>
      )}
    </div>
  )
}

// ─── 工具函数 ───

function fmt(s: number): string {
  if (!s || isNaN(s)) return '0:00'
  return (
    Math.floor(s / 60) +
    ':' +
    Math.floor(s % 60)
      .toString()
      .padStart(2, '0')
  )
}
