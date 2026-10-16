import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.resolve('')),
}))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}))

// 模块有全局状态，每个用例前重新加载
async function loadFresh() {
  vi.resetModules()
  vi.stubGlobal('window', { addEventListener: vi.fn() })
  return await import('../core/appLog')
}

describe('appLog 快照（useSyncExternalStore 契约）', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('新增日志后 getLogEntries() 必须返回新引用，否则 React 不会重渲染', async () => {
    const log = await loadFresh()
    log.installLogConsole()
    const before = log.getLogEntries()
    const lenBefore = before.length
    console.info('hello')
    const after = log.getLogEntries()
    expect(after.length).toBe(lenBefore + 1)
    expect(after).not.toBe(before)
  })

  it('无变化时快照引用保持稳定（避免无限重渲染）', async () => {
    const log = await loadFresh()
    log.installLogConsole()
    expect(log.getLogEntries()).toBe(log.getLogEntries())
  })

  it('clearLogEntries 后快照引用也要变化', async () => {
    const log = await loadFresh()
    log.installLogConsole()
    console.info('x')
    const before = log.getLogEntries()
    log.clearLogEntries()
    const after = log.getLogEntries()
    expect(after).not.toBe(before)
    expect(after.length).toBe(0)
  })

  it('超过上限时仍保持新引用且条数被裁剪', async () => {
    const log = await loadFresh()
    log.installLogConsole()
    for (let i = 0; i < 900; i++) console.debug(`m${i}`)
    const snap = log.getLogEntries()
    expect(snap.length).toBeLessThanOrEqual(800)
    console.debug('one more')
    expect(log.getLogEntries()).not.toBe(snap)
  })
})
