import { describe, it, expect, vi, beforeEach } from 'vitest'

const invokeMock = vi.fn((_cmd: string, _args?: Record<string, unknown>) =>
  Promise.resolve<unknown>(undefined)
)
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
}))

import {
  migrateLegacySecrets,
  secretHas,
  secretSet,
  SECRET_NAME_QWEATHER,
  QWEATHER_KEY_PLACEHOLDER,
} from '../plugins/settings/secrets'

const STORAGE_KEY = 'infoboard-settings'

/** 用 Map 伪造 localStorage（本仓库没有 DOM 测试环境） */
function fakeStorage(initial?: string) {
  const store = new Map<string, string>()
  if (initial !== undefined) store.set(STORAGE_KEY, initial)
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  })
  return {
    read: (): Record<string, unknown> => {
      const raw = store.get(STORAGE_KEY)
      if (raw === undefined) throw new Error('localStorage 里已经没有设置项了')
      return JSON.parse(raw) as Record<string, unknown>
    },
    raw: () => store.get(STORAGE_KEY),
  }
}

/** 落盘调用（忽略 secret_has 等其它 invoke） */
function setCalls() {
  return invokeMock.mock.calls.filter((c) => c[0] === 'secret_set')
}

describe('启动时清理 localStorage 里的明文凭据（P1-a）', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    invokeMock.mockClear()
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('旧版天气 Key 被迁到凭据管理器并从 localStorage 删除', async () => {
    const s = fakeStorage(
      JSON.stringify({ weatherCity: '101010100', weatherApiKey: 'legacy-secret', theme: 'dark' })
    )
    const r = await migrateLegacySecrets()

    expect(r.migratedWeatherKey).toBe(true)
    expect(setCalls()).toHaveLength(1)
    expect(setCalls()[0][1]).toMatchObject({
      name: SECRET_NAME_QWEATHER,
      value: 'legacy-secret',
    })
    const after = s.read()
    expect('weatherApiKey' in after).toBe(false)
    // 其它设置保持不变
    expect(after.weatherCity).toBe('101010100')
    expect(after.theme).toBe('dark')
    expect(JSON.stringify(after)).not.toContain('legacy-secret')
  })

  it('凭据库写入失败时保留旧值，不丢用户 Key', async () => {
    const s = fakeStorage(JSON.stringify({ weatherApiKey: 'legacy-secret' }))
    invokeMock.mockRejectedValueOnce(new Error('凭据库不可用'))

    const r = await migrateLegacySecrets()

    expect(r.migratedWeatherKey).toBe(false)
    expect(r.keptWeatherKey).toBe(true)
    expect(s.read().weatherApiKey).toBe('legacy-secret')
  })

  it('已删除功能遗留的明文凭据字段被删除（不迁移）', async () => {
    const s = fakeStorage(
      JSON.stringify({
        weatherCity: '101010100',
        minimaxApiKey: 'sk-cp-plaintext-leftover',
        opencodeToken: 'tok',
        theme: 'dark',
      })
    )
    const r = await migrateLegacySecrets()

    expect(r.removedFields.sort()).toEqual(['minimaxApiKey', 'opencodeToken'])
    const after = s.read()
    expect('minimaxApiKey' in after).toBe(false)
    expect('opencodeToken' in after).toBe(false)
    expect(after.theme).toBe('dark')
    // 这些值不该被写进凭据库（不在白名单里）
    expect(setCalls()).toHaveLength(0)
  })

  it('非凭据字段（含 weatherApiHost）不被误删', async () => {
    const s = fakeStorage(
      JSON.stringify({
        weatherApiHost: 'abc.qweatherapi.com',
        weatherCityName: '北京',
        disabledPlugins: ['todo'],
        autoStart: true,
      })
    )
    await migrateLegacySecrets()
    expect(s.read()).toEqual({
      weatherApiHost: 'abc.qweatherapi.com',
      weatherCityName: '北京',
      disabledPlugins: ['todo'],
      autoStart: true,
    })
  })

  it('没有遗留凭据时不写盘、不调用后端', async () => {
    const s = fakeStorage(JSON.stringify({ theme: 'dark' }))
    const before = s.raw()
    await migrateLegacySecrets()
    expect(invokeMock).not.toHaveBeenCalled()
    expect(s.raw()).toBe(before)
  })

  it('localStorage 损坏 / 缺字段时不抛错', async () => {
    fakeStorage('{不是合法 JSON')
    await expect(migrateLegacySecrets()).resolves.toMatchObject({ migratedWeatherKey: false })

    fakeStorage(JSON.stringify(['array']))
    await expect(migrateLegacySecrets()).resolves.toMatchObject({ migratedWeatherKey: false })

    vi.stubGlobal('localStorage', undefined)
    await expect(migrateLegacySecrets()).resolves.toMatchObject({ migratedWeatherKey: false })
  })
})

describe('凭据 API 封装', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    invokeMock.mockClear()
  })

  it('secret_set / secret_has 调用对应命令，前端不读明文', async () => {
    invokeMock.mockResolvedValueOnce(undefined)
    await secretSet(SECRET_NAME_QWEATHER, 'k')
    expect(invokeMock).toHaveBeenLastCalledWith('secret_set', { name: 'qweather', value: 'k' })

    invokeMock.mockResolvedValueOnce(true)
    expect(await secretHas(SECRET_NAME_QWEATHER)).toBe(true)
    expect(invokeMock).toHaveBeenLastCalledWith('secret_has', { name: 'qweather' })

    // 没有 secret_get 这回事
    const commands = invokeMock.mock.calls.map((c) => c[0])
    expect(commands).not.toContain('secret_get')
  })

  it('占位符是 Rust 侧认识的字面量', () => {
    expect(QWEATHER_KEY_PLACEHOLDER).toBe('{{QWEATHER_KEY}}')
  })
})
