import { describe, it, expect, vi } from 'vitest'
import { createWindowActiveStore, WINDOW_VISIBILITY_EVENT } from '../core/windowActive'

/** 可控的假依赖：手动决定 invoke / listen 何时 resolve，以及事件何时到来 */
function makeDeps() {
  let handler: ((event: { payload: unknown }) => void) | null = null
  const unlisten = vi.fn()
  let resolveInvoke: (v: unknown) => void = () => {}
  const invoke = vi.fn(
    () =>
      new Promise<unknown>((resolve) => {
        resolveInvoke = resolve
      })
  )
  const listen = vi.fn(async (_event: string, h: (event: { payload: unknown }) => void) => {
    handler = h
    return unlisten
  })
  return {
    deps: { invoke, listen },
    unlisten,
    invoke,
    listen,
    emit: (payload: unknown) => handler?.({ payload }),
    resolveInvoke: (v: unknown) => resolveInvoke(v),
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('窗口活跃状态 store', () => {
  it('默认活跃；初值来自 window_is_active', async () => {
    const d = makeDeps()
    const store = createWindowActiveStore(d.deps)

    expect(store.getSnapshot()).toBe(true)
    const started = store.start()
    await flush()
    expect(d.invoke).toHaveBeenCalledWith('window_is_active')

    d.resolveInvoke(false)
    await started
    expect(store.getSnapshot()).toBe(false)
  })

  it('事件到来后返回值翻转，并通知订阅者', async () => {
    const d = makeDeps()
    const store = createWindowActiveStore(d.deps)
    const listener = vi.fn()
    store.subscribe(listener)

    const started = store.start()
    await flush()
    d.resolveInvoke(true)
    await started

    expect(d.listen).toHaveBeenCalledWith(WINDOW_VISIBILITY_EVENT, expect.any(Function))
    expect(store.getSnapshot()).toBe(true)

    // 隐藏到托盘
    d.emit(false)
    expect(store.getSnapshot()).toBe(false)
    expect(listener).toHaveBeenCalledTimes(1)

    // 还原
    d.emit(true)
    expect(store.getSnapshot()).toBe(true)
    expect(listener).toHaveBeenCalledTimes(2)

    // 重复同值不通知（避免无谓重渲染）
    d.emit(true)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('事件比初值更新：事件先到时不被旧的 invoke 结果覆盖', async () => {
    const d = makeDeps()
    const store = createWindowActiveStore(d.deps)

    const started = store.start()
    await flush()

    // 事件先到（窗口刚被隐藏）
    d.emit(false)
    expect(store.getSnapshot()).toBe(false)

    // 之后 invoke 才返回"旧"的 true
    d.resolveInvoke(true)
    await started
    expect(store.getSnapshot()).toBe(false)
  })

  it('stop 后取消监听且不再响应事件', async () => {
    const d = makeDeps()
    const store = createWindowActiveStore(d.deps)

    const started = store.start()
    await flush()
    d.resolveInvoke(true)
    await started
    expect(d.unlisten).toHaveBeenCalledTimes(0)

    store.stop()
    expect(d.unlisten).toHaveBeenCalledTimes(1)

    d.emit(false)
    expect(store.getSnapshot()).toBe(true)
  })

  it('start 在 stop 之后才 resolve 时，监听会被立刻取消（不泄漏）', async () => {
    const off = vi.fn()
    let resolveListen: (off: () => void) => void = () => {}
    const store = createWindowActiveStore({
      invoke: vi.fn(() => Promise.resolve(true)),
      listen: vi.fn(() => new Promise<() => void>((resolve) => (resolveListen = resolve))),
    })

    const started = store.start()
    store.stop() // 清理先发生
    resolveListen(off)
    await started

    expect(off).toHaveBeenCalledTimes(1)
  })

  it('监听失败不影响初值读取（invoke 仍会调用）', async () => {
    const d = makeDeps()
    const store = createWindowActiveStore({
      invoke: d.deps.invoke,
      listen: vi.fn(() => Promise.reject(new Error('no tauri'))),
    })

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const started = store.start()
    await flush()
    d.resolveInvoke(false)
    await started
    warn.mockRestore()

    expect(store.getSnapshot()).toBe(false)
  })
})
