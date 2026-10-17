/**
 * 外部插件运行时：把磁盘上的 .tsx/.ts 源码转译并执行。
 *
 * 为什么需要它：WebView 读不到磁盘文件，应用里也没有编译器，
 * 所以 `import(meta.entryPath)` 永远不可能成功。这里改为：
 *   Rust 读出源码文本 → sucrase 转译为 CommonJS → 在受控的 require 环境里执行。
 *
 * 插件只能 require 下面 SHARED_MODULES 里列出的模块（与应用共用同一份实例，
 * 特别是 react，必须同一份，否则 hooks 会报错）。其他 import 一律报错。
 */

import { transform } from 'sucrase'
import * as React from 'react'
import * as ReactJsxRuntime from 'react/jsx-runtime'
import * as ReactDom from 'react-dom'
import * as TauriCore from '@tauri-apps/api/core'

export type SharedModules = Record<string, unknown>

/** 插件可以 import 的模块白名单 */
export const SHARED_MODULES: SharedModules = {
  react: React,
  'react/jsx-runtime': ReactJsxRuntime,
  'react-dom': ReactDom,
  '@tauri-apps/api/core': TauriCore,
  // '@tauri-apps/api/event' 不再导出：插件不应监听宿主事件（如 screenshot:data）
}

/**
 * 为单个插件构造模块表：把 `@tauri-apps/api/core` 换成带命令白名单的包装。
 *
 * `manifest.json` 里声明的 `tauriCommands` 就是这个插件允许调用的命令；
 * 没声明（或声明为空）时**默认全部拒绝**（fail-closed）。
 *
 * 注意：这只是**护栏，不是安全边界**——插件代码仍可直接用
 * `window.__TAURI_INTERNALS__.invoke` 绕过，`build.rs` 也没有限制自有命令
 * （见 HANDOVER「外部插件的限制」）。它的作用是让"没声明就用"变成显式报错，
 * 而不是悄悄生效。
 */
export function createPluginModules(
  tauriCommands: readonly string[] | undefined,
  base: SharedModules = SHARED_MODULES
): SharedModules {
  const allowed = new Set(
    (tauriCommands ?? []).map((c) => c.trim()).filter((c) => c.length > 0)
  )
  const core = base['@tauri-apps/api/core'] as {
    invoke: (cmd: string, args?: unknown, options?: unknown) => Promise<unknown>
  }

  return {
    ...base,
    '@tauri-apps/api/core': {
      ...core,
      invoke: (cmd: string, args?: unknown, options?: unknown): Promise<unknown> => {
        if (typeof cmd !== 'string' || !allowed.has(cmd)) {
          return Promise.reject(
            new PluginRuntimeError(
              `插件未声明命令 "${String(cmd)}"。请在 manifest.json 的 tauriCommands 里列出它（当前已声明: ${
                allowed.size ? [...allowed].join(', ') : '无'
              }）`
            )
          )
        }
        return core.invoke(cmd, args, options)
      },
    },
  }
}

/** 转译失败 / 执行失败 / import 了不允许的模块时抛出，信息面向插件作者 */
export class PluginRuntimeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PluginRuntimeError'
  }
}

/** 把 TS/TSX 源码转译成 CommonJS 代码 */
export function transpilePluginSource(source: string, filename: string): string {
  try {
    return transform(source, {
      // typescript: 擦除类型；jsx: 转成 React.createElement；imports: ESM → CommonJS
      transforms: ['typescript', 'jsx', 'imports'],
      // automatic：JSX 转为 require('react/jsx-runtime')，插件不必手写 import React
      jsxRuntime: 'automatic',
      filePath: filename,
      production: true,
    }).code
  } catch (e) {
    throw new PluginRuntimeError(`转译失败 (${filename}): ${e instanceof Error ? e.message : String(e)}`)
  }
}

/**
 * 转译并执行插件源码，返回它的 exports。
 *
 * @param modules 允许 require 的模块表（默认 SHARED_MODULES，测试可注入）
 */
export function evaluatePluginSource(
  source: string,
  filename: string,
  modules: SharedModules = SHARED_MODULES
): Record<string, unknown> {
  const code = transpilePluginSource(source, filename)

  const module = { exports: {} as Record<string, unknown> }

  const requireShared = (id: string): unknown => {
    if (Object.prototype.hasOwnProperty.call(modules, id)) return modules[id]
    throw new PluginRuntimeError(
      `插件 import 了不支持的模块 "${id}"。可用模块: ${Object.keys(modules).join(', ')}`
    )
  }

  try {
    // 用 Function 构造器而非 eval：不会访问调用处的局部作用域
    // eslint-disable-next-line no-new-func
    const run = new Function('module', 'exports', 'require', code)
    run(module, module.exports, requireShared)
  } catch (e) {
    if (e instanceof PluginRuntimeError) throw e
    throw new PluginRuntimeError(`执行失败 (${filename}): ${e instanceof Error ? e.message : String(e)}`)
  }
  return module.exports
}
