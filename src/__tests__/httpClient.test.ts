import { describe, it, expect, vi, beforeEach } from 'vitest'

const invokeMock = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }))

async function load() {
  vi.resetModules()
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
  return await import('../core/http-client')
}

/** 可手动完成的 invoke，模拟"后端响应很慢"的场景 */
function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

describe('http-client（Tauri 分支）取消语义', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    vi.unstubAllGlobals()
  })

  it('请求中途 abort：立刻以 AbortError(DOMException) 拒绝，不等后端响应', async () => {
    const { httpGetJson } = await load()
    const d = deferred<string>()
    invokeMock.mockReturnValue(d.promise)
    const c = new AbortController()
    const p = httpGetJson('https://devapi.qweather.com/x', c.signal)
    c.abort()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    await expect(p).rejects.toBeInstanceOf(DOMException)
  })

  it('发起前 signal 已 abort：不应调用后端', async () => {
    const { httpGetJson } = await load()
    const c = new AbortController()
    c.abort()
    await expect(httpGetJson('https://devapi.qweather.com/x', c.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('abort 之后到达的旧响应不会被当成成功结果', async () => {
    const { httpGetText } = await load()
    const d = deferred<string>()
    invokeMock.mockReturnValue(d.promise)
    const c = new AbortController()
    const p = httpGetText('https://devapi.qweather.com/x', c.signal)
    c.abort()
    d.resolve('stale-data')
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('未取消时正常返回', async () => {
    const { httpGetJson } = await load()
    invokeMock.mockResolvedValue('{"a":1}')
    const c = new AbortController()
    await expect(httpGetJson('https://devapi.qweather.com/x', c.signal)).resolves.toEqual({ a: 1 })
  })

  it('不传 signal 时仍可用', async () => {
    const { httpGetText } = await load()
    invokeMock.mockResolvedValue('hello')
    await expect(httpGetText('https://devapi.qweather.com/x')).resolves.toBe('hello')
  })

  it('后端报错仍抹平为带原因的 Error', async () => {
    const { httpGetText } = await load()
    invokeMock.mockRejectedValue('域名不在白名单: evil.com')
    await expect(httpGetText('https://evil.com/x')).rejects.toThrow('域名不在白名单')
  })
})
