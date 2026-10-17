import { describe, it, expect, vi, beforeEach } from 'vitest'

/** 本文件加载时 console 还没被 appLog 包装，留一份原生实现用于还原 */
const nativeConsole = {
  log: console.log,
  info: console.info,
  warn: console.warn,
  error: console.error,
  debug: console.debug,
}

const invokeMock = vi.fn((_cmd: string, _args?: Record<string, unknown>) => Promise.resolve(''))
let appLogHandler: ((event: { payload: unknown }) => void) | null = null

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
}))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((_event: string, handler: (event: { payload: unknown }) => void) => {
    appLogHandler = handler
    return Promise.resolve(() => {})
  }),
}))

// 模块有全局状态，每个用例前重新加载
async function loadFresh() {
  vi.resetModules()
  vi.stubGlobal('window', { addEventListener: vi.fn() })
  return await import('../core/appLog')
}

/** 落盘调用（忽略 log_get_path 等其它 invoke） */
function appendFileCalls() {
  return invokeMock.mock.calls.filter((c) => c[0] === 'log_append_file')
}

/** 每个 loadFresh 都会再包一层 console，多次加载会让一条日志被记多次 */
function resetConsole() {
  console.log = nativeConsole.log
  console.info = nativeConsole.info
  console.warn = nativeConsole.warn
  console.error = nativeConsole.error
  console.debug = nativeConsole.debug
}

describe('appLog 快照（useSyncExternalStore 契约）', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    invokeMock.mockClear()
    appLogHandler = null
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

describe('日志落盘（B6 重复写盘）', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    // 前面的用例已多次包装 console，先还原，保证本组只有当前实例在记
    resetConsole()
    invokeMock.mockClear()
    appLogHandler = null
  })

  /** 回归：Rust 侧 emit 已经直接写文件，前端再写一次会重复（且前缀变成 [web] [web]） */
  it('收到 rust 日志事件时不调用 log_append_file', async () => {
    const log = await loadFresh()
    log.installLogConsole()
    // installLogConsole 会挂 app_log 监听，回调被 mock 捕获
    expect(appLogHandler).not.toBeNull()

    appLogHandler!({ payload: { level: 'error', message: '来自后端', source: 'rust' } })

    const rust = log.getLogEntries().find((e) => e.message === '来自后端')
    expect(rust?.source).toBe('rust')
    expect(appendFileCalls()).toHaveLength(0)
  })

  it('web 侧 warn / error 仍会落盘，且消息里不再叠一层 [web]', async () => {
    const log = await loadFresh()
    log.installLogConsole()
    invokeMock.mockClear()

    console.warn('警告一条')
    console.error('错误一条')
    console.info('普通信息不落盘')

    const calls = appendFileCalls()
    expect(calls).toHaveLength(2)
    expect(calls[0][1]).toMatchObject({ level: 'warn', message: '警告一条' })
    expect(calls[1][1]).toMatchObject({ level: 'error', message: '错误一条' })
    for (const call of calls) {
      expect(String(call[1]?.message)).not.toContain('[web]')
    }
  })
})
