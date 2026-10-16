import { describe, it, expect, vi } from 'vitest'
import { PluginRegistry } from '../core/PluginRegistry'
import type { InfoBoardPlugin } from '../core/types'

function mk(id: string, onInit?: () => void): InfoBoardPlugin {
  return {
    manifest: { id, name: id, version: '1.0.0', author: 't', description: '', section: 'info' },
    Component: () => null,
    onInit,
  } as unknown as InfoBoardPlugin
}

describe('PluginRegistry.registerAll', () => {
  it('某个插件 onInit 抛错时，其余插件仍然被注册', () => {
    const reg = new PluginRegistry()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() =>
      reg.registerAll([
        mk('a'),
        mk('bad', () => {
          throw new Error('boom')
        }),
        mk('c'),
      ])
    ).not.toThrow()
    expect(reg.getPlugin('a')).toBeDefined()
    expect(reg.getPlugin('c')).toBeDefined()
  })

  it('重复 id 不会中断后续插件注册', () => {
    const reg = new PluginRegistry()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    reg.register(mk('dup'))
    expect(() => reg.registerAll([mk('x'), mk('dup'), mk('y')])).not.toThrow()
    expect(reg.getPlugin('x')).toBeDefined()
    expect(reg.getPlugin('y')).toBeDefined()
  })

  it('onInit 抛错的插件不应处于"半注册"状态', () => {
    const reg = new PluginRegistry()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    reg.registerAll([
      mk('bad', () => {
        throw new Error('boom')
      }),
    ])
    expect(reg.getPlugin('bad')).toBeUndefined()
  })

  it('单个 register 的重复 id 契约保持：仍然抛错', () => {
    const reg = new PluginRegistry()
    reg.register(mk('a'))
    expect(() => reg.register(mk('a'))).toThrow('已存在')
  })

  it('全部正常时与之前一致', () => {
    const reg = new PluginRegistry()
    reg.registerAll([mk('a'), mk('b')])
    expect(reg.size).toBe(2)
  })
})
