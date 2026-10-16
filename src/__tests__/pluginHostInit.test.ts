import { describe, it, expect, vi, beforeEach } from 'vitest'

const clearMock = vi.fn()
vi.mock('../core/PluginRegistry', () => ({
  pluginRegistry: {
    clear: () => clearMock(),
    registerAll: vi.fn(),
    size: 0,
  },
}))
vi.mock('../core/PluginLoader', () => ({
  pluginLoader: { loadExternalPlugins: vi.fn(async () => []) },
}))
vi.mock('../plugins', () => ({ plugins: [] }))

async function load() {
  vi.resetModules()
  vi.stubGlobal('localStorage', { getItem: () => null })
  return await import('../core/PluginHost')
}

describe('initPluginSystem 失败后可恢复', () => {
  beforeEach(() => {
    clearMock.mockReset()
    vi.unstubAllGlobals()
  })

  it('首次初始化失败后，再次调用应重新尝试而不是返回缓存的 rejected', async () => {
    const { initPluginSystem } = await load()
    clearMock.mockImplementationOnce(() => {
      throw new Error('first failure')
    })
    await expect(initPluginSystem()).rejects.toThrow('first failure')
    // 第二次：不应再拿到同一个已 reject 的 promise
    await expect(initPluginSystem()).resolves.toBeUndefined()
    expect(clearMock).toHaveBeenCalledTimes(2)
  })

  it('成功后重复调用复用同一次初始化（并发去重不变）', async () => {
    const { initPluginSystem } = await load()
    const a = initPluginSystem()
    const b = initPluginSystem()
    await Promise.all([a, b])
    expect(clearMock).toHaveBeenCalledTimes(1)
  })
})
