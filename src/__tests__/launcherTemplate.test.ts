/**
 * 「启动器插件模板」守卫
 *
 * 模板是给人抄的，抄错了要等到"拖进插件管理后点图标没反应"才发现 —— 太难查。
 * 这里把三件必须成立的事钉住：
 *
 * 1. manifest 声明了 `companion`，且 `dir` / `entry` 指向真实存在的文件；
 * 2. `companion.version` 与 `app/VERSION` 一致（版本号只有一个事实源）；
 * 3. 能真的打成一个包，且包里带上了程序本体（不是空壳）。
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { packPlugin } from '../../scripts/pack-plugin.mjs'

const TEMPLATE_DIR = join(process.cwd(), 'plugins', '.launcher-template')

interface CompanionDecl {
  dir: string
  entry: string
  version: string
  kind?: string
}

function readManifest(): {
  id: string
  version: string
  entry: string
  tauriCommands?: string[]
  companion?: CompanionDecl
} {
  return JSON.parse(readFileSync(join(TEMPLATE_DIR, 'manifest.json'), 'utf8'))
}

describe('启动器插件模板', () => {
  it('声明了 companion，且入口文件真实存在', () => {
    const manifest = readManifest()
    expect(manifest.companion).toBeTruthy()
    const decl = manifest.companion as CompanionDecl
    expect(existsSync(join(TEMPLATE_DIR, decl.dir, decl.entry))).toBe(true)
    expect(existsSync(join(TEMPLATE_DIR, decl.dir, 'VERSION'))).toBe(true)
    // kind 缺省是 python，模板里不需要写
    expect(decl.kind ?? 'python').toBe('python')
  })

  it('companion.version 与 app/VERSION 一致', () => {
    const manifest = readManifest()
    const decl = manifest.companion as CompanionDecl
    const version = readFileSync(join(TEMPLATE_DIR, decl.dir, 'VERSION'), 'utf8').trim()
    expect(decl.version).toBe(version)
    // 插件版本与内置程序版本一起走，别只改一边
    expect(manifest.version).toBe(version)
  })

  it('调用的命令都已声明（fail-closed 护栏）', () => {
    const source = readFileSync(join(TEMPLATE_DIR, 'index.tsx'), 'utf8')
    const declared = new Set(readManifest().tauriCommands ?? [])
    const used = [...source.matchAll(/invoke(?:<[^>]*>)?\(\s*'([^']+)'/g)].map((m) => m[1])
    expect(used.length).toBeGreaterThan(0)
    for (const cmd of used) {
      expect(declared.has(cmd), `invoke('${cmd}') 没有写进 manifest.tauriCommands`).toBe(true)
    }
  })

  it('能打成包，且包里带上了程序本体', () => {
    const pkg = packPlugin(TEMPLATE_DIR, { companionSource: join(TEMPLATE_DIR, 'app') })
    expect(pkg.files).toContain('app/main.py')
    expect(pkg.files).toContain('app/VERSION')
    expect(pkg.payloadCount).toBeGreaterThan(0)
  })
})
