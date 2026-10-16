import { describe, it, expect, vi, beforeEach } from 'vitest'

const invokeMock = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }))

import { toggleNativeDevtools, TOGGLE_DEVTOOLS_COMMAND } from '../core/devtools'

describe('toggleNativeDevtools', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    vi.spyOn(console, 'debug').mockImplementation(() => {})
  })

  /** 回归：命令属于 webview 插件，写成 plugin:core 会一直失败（且被吞掉） */
  it('调用 webview 插件下的命令', async () => {
    invokeMock.mockResolvedValue(undefined)
    await toggleNativeDevtools()
    expect(TOGGLE_DEVTOOLS_COMMAND).toBe('plugin:webview|internal_toggle_devtools')
    expect(invokeMock).toHaveBeenCalledWith('plugin:webview|internal_toggle_devtools')
  })

  it('release 构建里命令不存在时不抛错', async () => {
    invokeMock.mockImplementation(() => Promise.reject(new Error('command not found')))
    let threw = false
    try {
      await toggleNativeDevtools()
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
    expect(invokeMock).toHaveBeenCalledTimes(1)
  })
})
