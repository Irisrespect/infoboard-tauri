import { describe, it, expect, vi } from 'vitest'
import * as React from 'react'
import * as JsxRuntime from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  createPluginModules,
  evaluatePluginSource,
  PluginRuntimeError,
} from '../core/pluginRuntime'
// 用 Vite 的 ?raw 读取源码文本（不依赖 Node 类型）
import helloWorldSrc from '../../plugins/hello-world/index.tsx?raw'
import systemInfoSrc from '../../plugins/system-info/index.tsx?raw'
import templateSrc from '../../plugins/.plugin-template/index.tsx?raw'

const MODULES = { react: React, 'react/jsx-runtime': JsxRuntime }

describe('evaluatePluginSource', () => {
  it('转译 TSX 并取到 default 导出', () => {
    const src = `
      import type { InfoBoardPlugin } from '@/core/types'
      const P: InfoBoardPlugin = { manifest: { id: 'x' } as any, Component: () => null }
      export default P
    `
    const exp = evaluatePluginSource(src, 'index.tsx', MODULES) as { default: { manifest: { id: string } } }
    expect(exp.default.manifest.id).toBe('x')
  })

  it('import type 被擦除：不会 require 不存在的 @/core/types', () => {
    const src = `import type { A } from '@/core/types'\nexport const n: number = 1`
    expect(() => evaluatePluginSource(src, 'a.ts', MODULES)).not.toThrow()
  })

  it('JSX 组件能用共享的 react 渲染', () => {
    const src = `
      import { useState } from 'react'
      export default function C() {
        const [n] = useState(7)
        return <p className="x">count={n}</p>
      }
    `
    const exp = evaluatePluginSource(src, 'c.tsx', MODULES) as { default: React.FC }
    expect(renderToStaticMarkup(React.createElement(exp.default))).toBe('<p class="x">count=7</p>')
  })

  it('具名导出也可取到', () => {
    const exp = evaluatePluginSource(`export const plugin = { a: 1 }`, 'a.ts', MODULES)
    expect(exp.plugin).toEqual({ a: 1 })
  })

  it('import 白名单之外的模块：报清晰错误并列出可用模块', () => {
    const src = `import fs from 'node:fs'\nexport default fs`
    expect(() => evaluatePluginSource(src, 'bad.ts', MODULES)).toThrow(PluginRuntimeError)
    expect(() => evaluatePluginSource(src, 'bad.ts', MODULES)).toThrow(/node:fs.*可用模块.*react/s)
  })

  it('相对路径 import 同样被拒绝（单文件插件，不支持多文件）', () => {
    expect(() => evaluatePluginSource(`import x from './other'\nexport default x`, 'a.ts', MODULES)).toThrow(
      PluginRuntimeError
    )
  })

  it('语法错误：抛 PluginRuntimeError 且带文件名', () => {
    let err: unknown
    try {
      evaluatePluginSource(`export default (`, 'broken.tsx', MODULES)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(PluginRuntimeError)
    expect((err as Error).message).toContain('broken.tsx')
  })

  it('顶层运行时错误：抛 PluginRuntimeError 而不是原始异常', () => {
    expect(() => evaluatePluginSource(`throw new Error('boom')`, 'x.ts', MODULES)).toThrow(/执行失败.*boom/s)
  })

  it('插件拿不到调用处的局部变量（不是 eval）', () => {
    const secret = 'LOCAL-SECRET'
    void secret
    const exp = evaluatePluginSource(
      `export const v = typeof secret === 'undefined' ? 'isolated' : 'leaked'`,
      'x.ts',
      MODULES
    )
    expect(exp.v).toBe('isolated')
  })
})

describe('仓库自带示例插件可以真正被加载', () => {
  const samples: Array<[string, string, string]> = [
    ['hello-world', helloWorldSrc, 'hello-world'],
    ['system-info', systemInfoSrc, 'system-info'],
    // 模板也要能加载：作者照着它写，模板坏掉等于新插件全坏
    ['.plugin-template', templateSrc, 'my-plugin'],
  ]

  for (const [name, src, expectedId] of samples) {
    it(name, () => {
      const exp = evaluatePluginSource(src, `${name}/index.tsx`, MODULES) as {
        default: { manifest: { id: string }; Component: React.FC }
      }
      expect(exp.default.manifest.id).toBe(expectedId)
      expect(typeof exp.default.Component).toBe('function')
    })
  }
})

describe('插件命令白名单护栏（manifest.tauriCommands）', () => {
  const coreStub = {
    invoke: vi.fn((cmd: string) => Promise.resolve(`ok:${cmd}`)),
  }
  const modulesWithCore = {
    ...MODULES,
    '@tauri-apps/api/core': coreStub,
  }

  const callInvoke = (tauriCommands: string[] | undefined, cmd: string) => {
    const modules = createPluginModules(tauriCommands, modulesWithCore)
    const core = modules['@tauri-apps/api/core'] as {
      invoke: (c: string) => Promise<unknown>
    }
    return core.invoke(cmd)
  }

  it('声明过的命令可以调用', async () => {
    coreStub.invoke.mockClear()
    await expect(callInvoke(['window_is_active'], 'window_is_active')).resolves.toBe(
      'ok:window_is_active'
    )
    expect(coreStub.invoke).toHaveBeenCalledWith('window_is_active', undefined, undefined)
  })

  it('未声明的命令被拒绝，且错误信息告诉作者怎么修', async () => {
    coreStub.invoke.mockClear()
    await expect(callInvoke(['a'], 'secret_has')).rejects.toThrow(PluginRuntimeError)
    await expect(callInvoke(['a'], 'secret_has')).rejects.toThrow(/tauriCommands/)
    // 被拒绝时不应真的调用底层 invoke
    expect(coreStub.invoke).not.toHaveBeenCalled()
  })

  /** fail-closed：没声明就等于什么都没授权 */
  it('未声明 tauriCommands 时全部拒绝', async () => {
    coreStub.invoke.mockClear()
    await expect(callInvoke(undefined, 'window_is_close')).rejects.toThrow(PluginRuntimeError)
    await expect(callInvoke([], 'window_close')).rejects.toThrow(PluginRuntimeError)
    expect(coreStub.invoke).not.toHaveBeenCalled()
  })

  it('其它模块不受影响（react 必须是同一份实例，否则 hooks 报错）', () => {
    const modules = createPluginModules(undefined, modulesWithCore)
    expect(modules['react']).toBe(React)
    expect(modules['react/jsx-runtime']).toBe(JsxRuntime)
  })

  it('空字符串 / 空白项不会变成"允许调用空命令名"', async () => {
    coreStub.invoke.mockClear()
    await expect(callInvoke(['  ', ''], '')).rejects.toThrow(PluginRuntimeError)
    expect(coreStub.invoke).not.toHaveBeenCalled()
  })
})
