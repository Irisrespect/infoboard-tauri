import { describe, it, expect } from 'vitest'
import { ALLOWED_MODULES, checkRuntimeImports } from '../../scripts/pack-plugin.mjs'
// 用 Vite 的 ?raw 读源码文本（仓库既有做法，不依赖 Node 类型）
import runtimeSrc from '../core/pluginRuntime.ts?raw'
import packSrc from '../../scripts/pack-plugin.mjs?raw'

/**
 * 跨语言契约：打包脚本的 import 白名单必须与应用运行时的 `SHARED_MODULES` 一致。
 *
 * 两边分属不同语言、由不同测试覆盖，一旦只改一边就会出现最糟的情况 ——
 * 打包脚本放行、应用加载时才报错（作者拿到包却装不上）。
 * 这里直接读两侧源码比对，任何一边改动都会被立刻发现。
 */
function modulesInRuntimeSource(src: string): string[] {
  const block = src.match(/export const SHARED_MODULES[^{]*\{([\s\S]*?)\n\}/)
  if (!block) throw new Error('在 pluginRuntime.ts 里找不到 SHARED_MODULES')
  const found: string[] = []
  for (const line of block[1].split('\n')) {
    // 跳过注释行（例如"不再导出 @tauri-apps/api/event"的说明）
    const code = line.split('//')[0]
    // 匹配 `react: React` / `'react/jsx-runtime': X` / `'@tauri-apps/api/core': Y`
    const m = code.match(/^\s*(?:'([^']+)'|([A-Za-z_$][\w$]*))\s*:/)
    if (m) found.push(m[1] ?? m[2])
  }
  return found
}

function modulesInPackSource(src: string): string[] {
  const block = src.match(/export const ALLOWED_MODULES\s*=\s*\[([\s\S]*?)\]/)
  if (!block) throw new Error('在 pack-plugin.mjs 里找不到 ALLOWED_MODULES')
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
}

describe('import 白名单跨语言契约', () => {
  it('打包脚本的白名单与运行时 SHARED_MODULES 完全一致', () => {
    const runtime = modulesInRuntimeSource(runtimeSrc)
    const packer = modulesInPackSource(packSrc)
    expect(runtime.length).toBeGreaterThan(0)
    expect(packer).toEqual(runtime)
  })

  it('导出的 ALLOWED_MODULES 与源码里写的一致（没有解析偏差）', () => {
    expect(ALLOWED_MODULES).toEqual(modulesInPackSource(packSrc))
  })

  it('每个白名单模块都被预检放行', () => {
    for (const m of ALLOWED_MODULES) {
      expect(checkRuntimeImports(`import x from '${m}'`), m).toEqual([])
    }
  })

  /** 回归：event 已从白名单移除，两侧都要拒绝 */
  it('@tauri-apps/api/event 两侧都不在白名单', () => {
    expect(modulesInRuntimeSource(runtimeSrc)).not.toContain('@tauri-apps/api/event')
    expect(ALLOWED_MODULES).not.toContain('@tauri-apps/api/event')
    expect(checkRuntimeImports(`import { listen } from '@tauri-apps/api/event'`)).toHaveLength(1)
  })
})
