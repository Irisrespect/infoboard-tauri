import { describe, it, expect, vi, beforeEach } from 'vitest'

const invokeMock = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }))

// 测试跑在 node 环境（无 DOM）：bridge 失败时会 window.dispatchEvent，
// 这里补一个最小 window，只为收集派发出去的 CustomEvent。
if (typeof globalThis.window === 'undefined') {
  const listeners = new Map<string, Set<(e: Event) => void>>()
  ;(globalThis as { window?: unknown }).window = {
    addEventListener: (type: string, fn: (e: Event) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(fn)
    },
    removeEventListener: (type: string, fn: (e: Event) => void) => {
      listeners.get(type)?.delete(fn)
    },
    dispatchEvent: (event: Event) => {
      listeners.get(event.type)?.forEach((fn) => fn(event))
      return true
    },
  }
}

import { enrichMedia } from '../plugins/bilibili-info/bridge'

describe('enrichMedia 契约（失败不再伪装成"没有结果"）', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('有匹配时返回视频信息', async () => {
    const info = {
      cover: 'https://i0.hdslb.com/a.jpg',
      ownerName: 'UP',
      ownerAvatar: 'https://i0.hdslb.com/av.jpg',
      bvid: 'BV1xx',
      playCount: 1,
      danmakuCount: 2,
    }
    invokeMock.mockResolvedValue(info)
    await expect(enrichMedia('标题')).resolves.toEqual(info)
    expect(invokeMock).toHaveBeenCalledWith('bilibili_enrich_media', { title: '标题' })
  })

  it('查了但没有匹配 → 仍返回 null（不是错误）', async () => {
    invokeMock.mockResolvedValue(null)
    await expect(enrichMedia('标题')).resolves.toBeNull()
  })

  /**
   * 回归：Rust 侧现在用 Result<Option<..>, String> 表达失败。
   * 原先这里 catch 掉错误返回 null，调用方把"接口不通/风控/超时"
   * 与"确实没有这个视频"混为一谈，用户只看到"没有结果"。
   */
  it('请求失败 → 抛错，而不是返回 null', async () => {
    invokeMock.mockRejectedValue('B站搜索请求失败: 连接超时')
    await expect(enrichMedia('标题')).rejects.toThrow('B站搜索请求失败')
  })

  it('失败时派发 bilibili-enrich-error（供界面提示）', async () => {
    const events: CustomEvent[] = []
    const handler = (e: Event) => events.push(e as CustomEvent)
    window.addEventListener('bilibili-enrich-error', handler)
    try {
      invokeMock.mockRejectedValue('B站详情请求失败: HTTP 412')
      await expect(enrichMedia('某视频')).rejects.toThrow()
      expect(events).toHaveLength(1)
      expect(events[0].detail).toEqual({
        title: '某视频',
        message: 'B站详情请求失败: HTTP 412',
      })
    } finally {
      window.removeEventListener('bilibili-enrich-error', handler)
    }
  })

  it('成功时不派发错误事件', async () => {
    let count = 0
    const handler = () => {
      count += 1
    }
    window.addEventListener('bilibili-enrich-error', handler)
    try {
      invokeMock.mockResolvedValue(null)
      await enrichMedia('标题')
      expect(count).toBe(0)
    } finally {
      window.removeEventListener('bilibili-enrich-error', handler)
    }
  })
})
