/**
 * 播放进度条（本地 MusicPlayer）
 *
 * 进度只在组件内部按固定间隔读取（默认 250 ms），
 * 不再让整个灵动岛跟着约 60 fps 的插值重渲染。
 */

import { useEffect, useState } from 'react'

interface PlaybackProgressProps {
  /** 读取当前进度（秒），见 useMusicPlayerBridge 的 getPosition */
  getPosition: () => number
  /** 总时长（秒），<= 0 时不渲染 */
  duration: number
  /** 窗口隐藏 / 暂停时停止定时刷新 */
  animating?: boolean
  /** 刷新间隔，默认 250ms（够进度条用，不必每帧） */
  intervalMs?: number
}

export function PlaybackProgress({
  getPosition,
  duration,
  animating = true,
  intervalMs = 250,
}: PlaybackProgressProps) {
  const [position, setPosition] = useState(() => getPosition())

  useEffect(() => {
    // 参数变化后先同步一次，避免还原窗口时进度停在旧值
    setPosition(getPosition())
    if (!animating) return

    const timer = setInterval(() => setPosition(getPosition()), intervalMs)
    return () => clearInterval(timer)
  }, [getPosition, animating, intervalMs, duration])

  if (duration <= 0) return null

  const percent = Math.min(100, Math.max(0, (position / duration) * 100))

  return (
    <div className="px-3 py-1">
      <div className="w-full h-1 rounded-full" style={{ background: 'rgba(255,255,255,0.1)' }}>
        <div
          className="h-full rounded-full"
          style={{ width: `${percent}%`, background: 'var(--accent)' }}
        />
      </div>
      <div className="flex justify-between mt-1">
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
          {fmtTime(position)}
        </span>
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
          {fmtTime(duration)}
        </span>
      </div>
    </div>
  )
}

/** 秒 → m:ss */
export function fmtTime(s: number): string {
  if (!s || isNaN(s)) return '0:00'
  return (
    Math.floor(s / 60) +
    ':' +
    Math.floor(s % 60)
      .toString()
      .padStart(2, '0')
  )
}
