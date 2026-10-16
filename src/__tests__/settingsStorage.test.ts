import { describe, it, expect } from 'vitest'
import { sanitizeSettings, DEFAULT_SETTINGS } from '../plugins/settings/settingsStorage'

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
