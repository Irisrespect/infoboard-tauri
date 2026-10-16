/**
 * MusicPlayer 本地 HTTP 桥
 *
 * 轮询 127.0.0.1:17831（可选本地播放器）。
 * 离线时指数退避，避免控制台 ERR_CONNECTION_REFUSED 刷屏。
 * 窗口隐藏到托盘 / 最小化时停止轮询与进度插值（省电）。
 *
 * 进度不再放进 React state：原先用 requestAnimationFrame 每帧 setState，
 * 等于以约 60 fps 重渲染整棵灵动岛，窗口隐藏后也不停。现在进度放在 ref 里，
 * 由需要的组件（歌词、进度条）自己按需读取。
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { useWindowActive } from '../../core/useWindowActive'

const PLAYER_API_URL = 'http://127.0.0.1:17831/state'
/** 在线时轮询间隔 */
const ONLINE_POLL_MS = 1000
/** 离线退避：1s → 2s → 4s → … → 30s */
const OFFLINE_MIN_MS = 1000
const OFFLINE_MAX_MS = 30_000

interface LyricLine {
  time: number
  text: string
}

interface RawResponse {
  active: boolean
  state: 'playing' | 'paused' | 'stopped'
  title: string
  artist: string
  thumbnail: string
  position: number
  duration: number
  lyricsOffset: number
  lyrics: LyricLine[]
}

export interface PlayerState {
  isOnline: boolean
  playbackState: 'playing' | 'paused' | 'stopped'
  title: string
  artist: string
  thumbnail: string
  duration: number
  lyrics: LyricLine[]
  lyricsOffset: number
}

export interface MusicPlayerBridgeState extends PlayerState {
  /**
   * 读取"此刻"的播放进度（秒）。
   * 本地播放器只在轮询时给一个基准点，两次轮询之间按经过时间插值。
   * 这是普通函数而非 state，读取它不会触发重渲染。
   */
  getPosition: () => number
  /** 主窗口是否活跃；不活跃时调用方应停止自己的动画（如歌词滚动） */
  windowActive: boolean
}

const OFFLINE_STATE: PlayerState = {
  isOnline: false,
  playbackState: 'stopped',
  title: '',
  artist: '',
  thumbnail: '',
  duration: 0,
  lyrics: [],
  lyricsOffset: 0,
}

/** 只有离散字段变化时才 setState，避免每秒轮询都重渲染 */
function sameState(a: PlayerState, b: PlayerState): boolean {
  return (
    a.isOnline === b.isOnline &&
    a.playbackState === b.playbackState &&
    a.title === b.title &&
    a.artist === b.artist &&
    a.thumbnail === b.thumbnail &&
    a.duration === b.duration &&
    a.lyricsOffset === b.lyricsOffset &&
    a.lyrics === b.lyrics
  )
}

export function useMusicPlayerBridge(): MusicPlayerBridgeState {
  const [state, setState] = useState<PlayerState>(OFFLINE_STATE)
  const active = useWindowActive()

  /** 进度插值的基准点（不触发渲染） */
  const lastServerPosRef = useRef(0)
  const lastServerTimeRef = useRef(0)
  const playingRef = useRef(false)
  const durationRef = useRef(0)
  /** 连续失败次数与"已提示离线"标记，跨"隐藏→显示"周期保留 */
  const failStreakRef = useRef(0)
  const loggedOfflineRef = useRef(false)

  const getPosition = useCallback(() => {
    const duration = durationRef.current
    if (!playingRef.current || lastServerTimeRef.current <= 0) {
      return lastServerPosRef.current
    }
    const elapsed = (performance.now() - lastServerTimeRef.current) / 1000
    const estimated = lastServerPosRef.current + elapsed
    return duration > 0 ? Math.min(estimated, duration) : estimated
  }, [])

  const applyState = useCallback((next: PlayerState) => {
    setState((prev) => (sameState(prev, next) ? prev : next))
  }, [])

  useEffect(() => {
    // 窗口不可见：不轮询、不插值
    if (!active) return

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const scheduleNext = (ms: number) => {
      if (cancelled) return
      timer = setTimeout(() => {
        void fetchState()
      }, ms)
    }

    const fetchState = async () => {
      try {
        const resp = await fetch(PLAYER_API_URL, {
          signal: AbortSignal.timeout(1500),
        })
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
        const data: RawResponse = await resp.json()

        failStreakRef.current = 0
        if (loggedOfflineRef.current) {
          console.log('[MusicPlayer] 本地播放器已连接')
          loggedOfflineRef.current = false
        }

        lastServerPosRef.current = data.position
        lastServerTimeRef.current = performance.now()
        playingRef.current = data.state === 'playing'
        durationRef.current = data.duration

        if (!cancelled) {
          applyState({
            isOnline: data.active,
            playbackState: data.state,
            title: data.title || '',
            artist: data.artist || '',
            thumbnail: data.thumbnail || '',
            duration: data.duration,
            lyrics: data.lyrics || [],
            lyricsOffset: data.lyricsOffset || 0,
          })
        }
        scheduleNext(ONLINE_POLL_MS)
      } catch {
        // 本地服务未启动是正常情况，静默退避
        failStreakRef.current += 1
        playingRef.current = false
        lastServerTimeRef.current = 0
        if (!loggedOfflineRef.current) {
          console.info(
            '[MusicPlayer] 本地服务未运行 (127.0.0.1:17831)，已暂停高频轮询；启动 MusicPlayer 后自动恢复'
          )
          loggedOfflineRef.current = true
        }
        if (!cancelled) {
          setState((prev) => {
            if (!prev.isOnline && prev.playbackState === 'stopped') return prev
            return { ...OFFLINE_STATE }
          })
        }
        const backoff = Math.min(
          OFFLINE_MAX_MS,
          OFFLINE_MIN_MS * Math.pow(2, Math.min(failStreakRef.current - 1, 5))
        )
        scheduleNext(backoff)
      }
    }

    void fetchState()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [active, applyState])

  return { ...state, getPosition, windowActive: active }
}
