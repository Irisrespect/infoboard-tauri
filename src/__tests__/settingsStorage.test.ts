import { describe, it, expect, vi } from 'vitest'
import {
  sanitizeSettings,
  DEFAULT_SETTINGS,
  loadSettings,
  persistSettings,
  SETTINGS_STORAGE_KEY,
} from '../plugins/settings/settingsStorage'

/** 用 Map 伪造 localStorage */
function fakeStorage(initial?: string) {
  const store = new Map<string, string>()
  if (initial !== undefined) store.set(SETTINGS_STORAGE_KEY, initial)
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    raw: () => store.get(SETTINGS_STORAGE_KEY),
  }
}

describe('sanitizeSettings（localStorage 脏数据不得让设置面板崩溃）', () => {
  it('非对象输入回退为默认值', () => {
    for (const bad of [null, undefined, 'str', 42, true, []]) {
      expect(sanitizeSettings(bad)).toEqual(DEFAULT_SETTINGS)
    }
  })

  it('disabledPlugins 为 null / 字符串 / 对象时回退为空数组', () => {
    for (const bad of [null, 'a,b', { 0: 'x' }, 7]) {
      const s = sanitizeSettings({ disabledPlugins: bad })
      expect(Array.isArray(s.disabledPlugins)).toBe(true)
      expect(s.disabledPlugins).toEqual([])
      // 面板里直接调用 .includes，不能抛错
      expect(() => s.disabledPlugins.includes('x')).not.toThrow()
    }
  })

  it('disabledPlugins 中的非字符串元素被过滤', () => {
    const s = sanitizeSettings({ disabledPlugins: ['a', 1, null, 'b', {}] })
    expect(s.disabledPlugins).toEqual(['a', 'b'])
  })

  it('theme 非法时回退默认，合法值保留', () => {
    expect(sanitizeSettings({ theme: 'neon' }).theme).toBe(DEFAULT_SETTINGS.theme)
    expect(sanitizeSettings({ theme: 123 }).theme).toBe(DEFAULT_SETTINGS.theme)
    expect(sanitizeSettings({ theme: 'dark' }).theme).toBe('dark')
    expect(sanitizeSettings({ theme: 'system' }).theme).toBe('system')
  })

  it('字符串字段类型错误时回退默认，autoStart 非布尔回退', () => {
    const s = sanitizeSettings({ weatherCity: 123, weatherApiHost: null, autoStart: 'yes' })
    expect(s.weatherCity).toBe(DEFAULT_SETTINGS.weatherCity)
    expect(s.weatherApiHost).toBe(DEFAULT_SETTINGS.weatherApiHost)
    expect(s.autoStart).toBe(false)
  })

  it('合法数据原样保留', () => {
    const s = sanitizeSettings({
      weatherCity: '101020100',
      weatherCityName: '上海',
      weatherApiHost: 'h',
      theme: 'pink-purple',
      disabledPlugins: ['todo'],
      autoStart: true,
    })
    expect(s).toEqual({
      weatherCity: '101020100',
      weatherCityName: '上海',
      weatherApiHost: 'h',
      theme: 'pink-purple',
      disabledPlugins: ['todo'],
      autoStart: true,
    })
  })

  it('未知字段被丢弃（含已删除功能残留的 minimaxApiKey）', () => {
    const s = sanitizeSettings({ minimaxApiKey: 'old-secret', junk: 1 }) as unknown as Record<
      string,
      unknown
    >
    expect('minimaxApiKey' in s).toBe(false)
    expect('junk' in s).toBe(false)
  })

  /// 回归（P1-a）：API Key 不再是设置项，不能回到 localStorage
  it('weatherApiKey 被丢弃（Key 改存凭据管理器）', () => {
    const s = sanitizeSettings({
      weatherCity: '101010100',
      weatherApiKey: 'plaintext-secret',
    }) as unknown as Record<string, unknown>
    expect('weatherApiKey' in s).toBe(false)
    expect(JSON.stringify(s)).not.toContain('plaintext-secret')
  })
})

describe('设置读写（F2：副作用移出 updater 后由这里负责落盘）', () => {
  it('写入后能读回', () => {
    const s = fakeStorage()
    const next = { ...DEFAULT_SETTINGS, theme: 'dark' as const, weatherCity: '101020100' }
    expect(persistSettings(next, s)).toBe(true)
    expect(loadSettings(s)).toEqual(next)
  })

  it('写盘失败返回 false（调用方据此提示用户，不再静默）', () => {
    const failing = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('QuotaExceededError')
      },
    }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(persistSettings(DEFAULT_SETTINGS, failing)).toBe(false)
    spy.mockRestore()
  })

  it('读取时脏数据回退默认值', () => {
    expect(loadSettings(fakeStorage('{坏 JSON'))).toEqual(DEFAULT_SETTINGS)
    expect(loadSettings(fakeStorage('"字符串"'))).toEqual(DEFAULT_SETTINGS)
    expect(loadSettings(fakeStorage()).theme).toBe(DEFAULT_SETTINGS.theme)
  })
})
