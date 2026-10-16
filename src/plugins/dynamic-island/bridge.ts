/**
 * 灵动岛 — SMTC 媒体控制 Tauri invoke 封装
 *
 * 提供 SMTC 媒体会话查询和控制方法
 */

import { invoke } from '@tauri-apps/api/core'
import type { MediaSession } from './types'

/**
 * 获取当前 SMTC 媒体会话
 *
 * @returns 当前媒体会话，无活跃会话时返回 null
 */
export async function getCurrentSession(): Promise<MediaSession | null> {
  try {
    const result = await invoke<MediaSession | null>('media_get_current_session')
    // 不要把整个结果打进控制台：thumbnail 是约 700 KB 的 base64
    console.debug(
      '[dynamic-island] getCurrentSession:',
      result ? `"${result.title}" (${result.playbackStatus})` : '无会话'
    )
    return result
  } catch (err) {
    console.error('[dynamic-island] getCurrentSession 失败:', err)
    return null
  }
}

/**
 * 发送播放控制命令
 *
 * @param command - 播放控制命令
 * @returns 是否成功
 */
export async function sendCommand(
  command: 'play' | 'pause' | 'toggle' | 'next' | 'previous'
): Promise<boolean> {
  try {
    return await invoke<boolean>('media_send_command', { command })
  } catch (err) {
    console.error('[dynamic-island] sendCommand 失败:', err)
    return false
  }
}
