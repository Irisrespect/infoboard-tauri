/**
 * 歌词面板
 *
 * 当前行由本组件自己按 `getPosition()` 计算：
 * 播放进度不是 React state（每轮询一次基准点 + 读取时插值），
 * 所以这里用 requestAnimationFrame 读取进度，**只在换行时** setState，
 * 并且每行都是 memo 组件——一次换行只重渲染受影响的两行，
 * 而不是原先那样每帧重渲染整棵灵动岛。窗口隐藏时停止 rAF。
 */

import { memo, useEffect, useRef, useState } from 'react'
import { findCurrentLyricIndex, type LyricLine } from './lyrics'

interface LyricsViewProps {
  lyrics: LyricLine[]
  loading: boolean
  height?: number
  /** 读取当前播放进度（秒）。不传则不计算高亮行 */
  getPosition?: () => number
  /** 歌词时间偏移（秒） */
  lyricsOffset?: number
  /** 是否允许动画（窗口隐藏时置 false，停止 rAF） */
  animating?: boolean
}

/** 按当前进度算歌词下标；无同步歌词（全部 time<=0）时返回 -1（纯函数，便于测试） */
export { findCurrentLyricIndex } from './lyrics'

const LyricRow = memo(function LyricRow({
  text,
  isCurrent,
  isSynced,
}: {
  text: string
  isCurrent: boolean
  isSynced: boolean
}) {
  return (
    <p
      className="leading-relaxed transition-all duration-300 text-center"
      style={{
        color: isCurrent ? 'var(--text-primary)' : 'var(--text-muted)',
        fontWeight: isCurrent ? 600 : 400,
        fontSize: isCurrent ? '0.9rem' : '0.78rem',
        opacity: isSynced ? (isCurrent ? 1 : 0.45) : 0.7,
      }}
    >
      {text}
    </p>
  )
})

export function LyricsView({
  lyrics,
  loading,
  height,
  getPosition,
  lyricsOffset = 0,
  animating = true,
}: LyricsViewProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const indexRef = useRef(-1)
  const [currentIndex, setCurrentIndex] = useState(-1)

  const isSynced = lyrics.some((l) => l.time > 0)

  // 按需推进当前行：每帧只读进度，换行时才触发渲染
  useEffect(() => {
    if (!getPosition || !animating || !isSynced) return

    let frame = 0
    const tick = () => {
      const next = findCurrentLyricIndex(lyrics, getPosition() + lyricsOffset)
      if (next !== indexRef.current) {
        indexRef.current = next
        setCurrentIndex(next)
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [lyrics, lyricsOffset, getPosition, animating, isSynced])

  // 当前行滚动到可视区中部
  useEffect(() => {
    if (currentIndex < 0 || !panelRef.current) return
    const el = panelRef.current.children[0]?.children[currentIndex] as HTMLElement | undefined
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [currentIndex])

  if (loading) {
    return (
      <div
        className="w-full flex items-center justify-center py-6"
        style={{ height: height || 'auto' }}
      >
        <p className="text-xs animate-pulse" style={{ color: 'var(--text-muted)' }}>
          正在获取歌词...
        </p>
      </div>
    )
  }

  if (!lyrics.length) {
    return (
      <div
        className="w-full flex flex-col items-center justify-center py-6"
        style={{ height: height || 'auto' }}
      >
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          暂无歌词
        </p>
      </div>
    )
  }

  return (
    <div
      ref={panelRef}
      className="w-full overflow-y-auto"
      style={{ scrollBehavior: 'smooth', maxHeight: 200 }}
    >
      <div className="space-y-1.5 px-1">
        {lyrics.map((line, i) => (
          <LyricRow
            key={i}
            text={line.text}
            isCurrent={isSynced && i === currentIndex}
            isSynced={isSynced}
          />
        ))}
      </div>
    </div>
  )
}
