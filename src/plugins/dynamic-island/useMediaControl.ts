/**
 * 媒体控制 Hook
 *
 * 提供媒体会话状态和控制方法
 * 窗口活跃时轮询 SMTC 会话变化（每 2 秒），实时更新状态；
 * 隐藏到托盘 / 最小化后停止轮询（由 Rust 的 window:visibility 事件驱动）
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import type { MediaSession, PlaybackStatus } from './types'
import { getCurrentSession, sendCommand as bridgeSendCommand } from './bridge'
import { enrichMedia } from '../bilibili-info/bridge'
import { useWindowActive } from '../../core/useWindowActive'

/** B站信息缓存：title → enriched data */
const bilibiliCache = new Map<
  string,
  { thumbnail: string; artist: string; ownerAvatar: string; expires: number }
>()
const BILI_CACHE_TTL = 30 * 60 * 1000 // 30 分钟

/** Hook 返回值类型 */
interface UseMediaControlReturn {
  /** 当前媒体会话（null 表示无活跃会话） */
  currentMedia: MediaSession | null

  /** 是否正在加载 */
  isLoading: boolean

  /** 错误信息 */
  error: string | null

  /** 发送播放控制命令 */
  sendCommand: (command: 'play' | 'pause' | 'toggle' | 'next' | 'previous') => Promise<boolean>

  /** 手动刷新会话 */
  refresh: () => Promise<void>
}

/**
 * 媒体控制 Hook
 *
 * 通过 Tauri invoke 轮询 SMTC 会话状态（每 2 秒）
 */
export function useMediaControl(): UseMediaControlReturn {
  const [currentMedia, setCurrentMedia] = useState<MediaSession | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  /** 窗口是否活跃（隐藏到托盘 / 最小化 → false，前后端都不该再查 SMTC） */
  const active = useWindowActive()

  /** 保存 sendCommand 中 setTimeout 的引用，用于卸载时清理 */
  const commandTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  /** 上次日志签名，避免 2s 轮询刷屏 */
  const lastLogKeyRef = useRef('')

  const fetchSession = useCallback(async () => {
    try {
      setError(null)
      const session = await getCurrentSession()
      const logKey = session
        ? `${session.title}|${session.playbackStatus}|${session.sourceAppId || ''}`
        : '(none)'
      if (logKey !== lastLogKeyRef.current) {
        lastLogKeyRef.current = logKey
        if (session) {
          console.log(`[SMTC] 检测到媒体: "${session.title}" (${session.playbackStatus})`)
        } else {
          console.log('[SMTC] 无活跃媒体会话')
        }
      }

      // 检测B站来源，自动补充封面和UP主信息
      if (session && isBilibiliSource(session.sourceAppId) && session.title) {
        const enriched = await enrichBilibiliSession(session)
        setCurrentMedia(enriched)
      } else {
        setCurrentMedia(session)
      }
    } catch (err) {
      console.error('[useMediaControl] 获取会话失败:', err)
      setError('获取媒体会话失败')
    } finally {
      setIsLoading(false)
    }
  }, [])

  /**
   * 发送播放控制命令
   */
  const sendCommand = useCallback(
    async (command: 'play' | 'pause' | 'toggle' | 'next' | 'previous') => {
      console.log(`[SMTC] 发送命令: ${command}`)
      try {
        const success = await bridgeSendCommand(command)

        // 命令发送后延迟刷新状态（等待 SMTC 更新）
        if (success) {
          // 清除前一个超时（防止快速连续点击导致堆积）
          if (commandTimeoutRef.current) {
            clearTimeout(commandTimeoutRef.current)
          }
          commandTimeoutRef.current = setTimeout(() => {
            commandTimeoutRef.current = null
            fetchSession()
          }, 500)
        }

        return success
      } catch (err) {
        console.error('[useMediaControl] 发送命令失败:', err)
        return false
      }
    },
    [fetchSession]
  )

  const refresh = useCallback(async () => {
    setIsLoading(true)
    await fetchSession()
  }, [fetchSession])

  /**
   * 初始化：窗口活跃时立即获取 + 每 2 秒轮询；不活跃时连定时器都不创建，
   * 变回活跃时先补一次 fetchSession 再启动定时器
   */
  useEffect(() => {
    if (!active) return

    let unmounted = false

    // 立即获取一次（还原窗口后立刻刷新，而非等 2 秒）
    fetchSession().catch(() => {})

    // 每 2 秒轮询
    const timer = setInterval(() => {
      if (!unmounted) fetchSession().catch(() => {})
    }, 2000)

    return () => {
      unmounted = true
      clearInterval(timer)
    }
  }, [active, fetchSession])

  /** 卸载时清理未执行的延迟刷新 */
  useEffect(
    () => () => {
      if (commandTimeoutRef.current) {
        clearTimeout(commandTimeoutRef.current)
        commandTimeoutRef.current = null
      }
    },
    []
  )

  return {
    currentMedia,
    isLoading,
    error,
    sendCommand,
    refresh,
  }
}

/**
 * 格式化播放状态为中文
 */
export function formatPlaybackStatus(status: PlaybackStatus): string {
  switch (status) {
    case 'playing':
      return '播放中'
    case 'paused':
      return '已暂停'
    case 'stopped':
      return '已停止'
    case 'closed':
      return '已关闭'
    default:
      return '未知'
  }
}

// ─── B站信息补充 ───

/** 判断是否为B站来源 */
function isBilibiliSource(sourceAppId?: string): boolean {
  if (!sourceAppId) return false
  const lower = sourceAppId.toLowerCase()
  return lower.includes('bilibili') || lower.includes('哔哩哔哩')
}

/** 补充B站媒体会话信息（封面 + UP主） */
async function enrichBilibiliSession(session: MediaSession): Promise<MediaSession> {
  const title = session.title

  // 检查缓存
  const cached = bilibiliCache.get(title)
  if (cached && cached.expires > Date.now()) {
    return {
      ...session,
      thumbnail: cached.thumbnail || session.thumbnail,
      artist: cached.artist || session.artist,
      ownerAvatar: cached.ownerAvatar,
    }
  }

  // 调用 Tauri invoke 获取B站视频信息
  try {
    const info = await enrichMedia(title)
    if (!info) {
      console.debug('[B站] 封面补全：API 无结果')
      return session
    }

    // B站封面/头像 API 返回的可能是 http://，WebView 可能被 CSP/mixed content 拦截 → 升级为 https
    const safeUrl = (url: string): string => url.replace(/^http:\/\//, 'https://')

    const thumbnail = safeUrl(info.cover) || session.thumbnail || ''
    const ownerAvatar = safeUrl(info.ownerAvatar || '')

    // 写入缓存
    bilibiliCache.set(title, {
      thumbnail,
      artist: info.ownerName,
      ownerAvatar,
      expires: Date.now() + BILI_CACHE_TTL,
    })

    console.debug('[B站] 封面补全成功', {
      title,
      thumbnail: (thumbnail || '').slice(0, 60),
      owner: info.ownerName,
    })

    return {
      ...session,
      thumbnail,
      artist: info.ownerName || session.artist,
      ownerAvatar,
    }
  } catch (err) {
    console.warn('[useMediaControl] B站信息补充失败:', err)
    return session
  }
}
