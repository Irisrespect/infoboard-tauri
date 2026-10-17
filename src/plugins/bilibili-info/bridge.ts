/**
 * B站视频信息补充 — Tauri invoke 封装
 *
 * 通过 B站公开 API 搜索视频标题，获取封面图、UP主名称/头像、BV 号、播放量/弹幕数
 */

import { invoke } from '@tauri-apps/api/core'

/** B站视频信息 */
export interface BilibiliVideoInfo {
  /** 封面图 URL */
  cover: string
  /** UP主名称 */
  ownerName: string
  /** UP主头像 URL */
  ownerAvatar: string
  /** BV 号 */
  bvid: string
  /** 播放量 */
  playCount: number
  /** 弹幕数 */
  danmakuCount: number
}

/**
 * 补充 B站视频信息
 *
 * 三种结果要区分开（原先都返回 null，用户分不清）：
 * - 有匹配 → `BilibiliVideoInfo`
 * - 查了但没有匹配（无搜索结果 / 结果里没有可用条目）→ `null`
 * - 请求或解析失败（接口不通、风控、超时）→ **抛错**，并派发 `bilibili-enrich-error`
 *   让界面能提示"B站信息补全失败"，而不是把失败显示成"没有结果"
 *
 * @param title - 视频标题
 *
 * @example
 * ```ts
 * const info = await enrichMedia('【4K】赛博朋克2077 全剧情电影')
 * if (info) {
 *   console.log(info.ownerName) // "影视飓风"
 * }
 * ```
 */
export async function enrichMedia(title: string): Promise<BilibiliVideoInfo | null> {
  try {
    return await invoke<BilibiliVideoInfo | null>('bilibili_enrich_media', { title })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[bilibili-info] enrichMedia 失败:', message)
    window.dispatchEvent(
      new CustomEvent('bilibili-enrich-error', { detail: { title, message } })
    )
    throw new Error(message)
  }
}
