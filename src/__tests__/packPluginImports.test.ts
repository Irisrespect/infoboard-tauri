import { describe, it, expect } from 'vitest'
import {
  checkRuntimeImports,
  findRuntimeImports,
  packPlugin,
  ALLOWED_MODULES,
  MAX_ENTRY_BYTES,
} from '../../scripts/pack-plugin.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

function pluginDir(entry: string, extraManifest: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pack-imports-'))
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      id: 'imp',
      name: 'n',
      version: '1.0.0',
      section: 'info',
      icon: '🔧',
      entry: 'index.tsx',
      ...extraManifest,
    })
  )
  writeFileSync(join(dir, 'index.tsx'), entry)
  return dir
}

describe('findRuntimeImports', () => {
  it('找出真正会 require 的 import', () => {
    const src = `
import { useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import './other'
`
    expect(findRuntimeImports(src).sort()).toEqual(
      ['react', '@tauri-apps/api/core', './other'].sort()
    )
  })

  /** 关键：import type 被 sucrase 擦除，运行时不会 require，不该被误报 */
  it('跳过 import type（会被擦除，不受白名单限制）', () => {
    const src = `
import type { InfoBoardPlugin } from '@/core/types'
import type { Foo } from 'some-npm-package'
`
    expect(findRuntimeImports(src)).toEqual([])
  })

  it('同一模块重复 import 只算一次', () => {
    expect(findRuntimeImports(`import { a } from 'react'\nimport { b } from 'react'`)).toEqual([
      'react',
    ])
  })

  it('捕获副作用 import 与动态 import', () => {
    const src = `import 'zone.js'\nconst m = await import('lodash')`
    expect(findRuntimeImports(src).sort()).toEqual(['lodash', 'zone.js'])
  })

  it('多行 import 也能识别', () => {
    const src = `import {\n  useState,\n  useEffect,\n} from 'react'`
    expect(findRuntimeImports(src)).toEqual(['react'])
  })
})

describe('checkRuntimeImports', () => {
  it('白名单内的模块通过', () => {
    expect(checkRuntimeImports(`import { useState } from 'react'`)).toEqual([])
    for (const m of ALLOWED_MODULES) {
      expect(checkRuntimeImports(`import x from '${m}'`), m).toEqual([])
    }
  })

  it('不在白名单且非相对路径 → 报错并列出可用模块', () => {
    const problems = checkRuntimeImports(`import _ from 'lodash'`)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('lodash')
    expect(problems[0]).toContain('react')
  })

  /** 最常见的坑：为了拆文件写成相对 import，运行时必被拒 */
  it('相对路径 import → 提示必须单文件', () => {
    const problems = checkRuntimeImports(`import { helper } from './helper'`)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('单文件')
  })

  it('@tauri-apps/api/event 会被点名（该模块已从白名单移除）', () => {
    const problems = checkRuntimeImports(`import { listen } from '@tauri-apps/api/event'`)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('@tauri-apps/api/event')
  })
})

describe('packPlugin 的可加载性预检', () => {
  it('白名单外的 import 直接拒绝打包，并说明原因', () => {
    const dir = pluginDir(`import { chunk } from 'lodash'\nexport default 1`)
    try {
      expect(() => packPlugin(dir)).toThrow(/lodash/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('相对路径 import 直接拒绝打包', () => {
    const dir = pluginDir(`import { x } from './util'\nexport default x`)
    try {
      expect(() => packPlugin(dir)).toThrow(/单文件/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('只用 import type + react 的正常插件可以打包', () => {
    const dir = pluginDir(
      `import type { InfoBoardPlugin } from '@/core/types'\nimport { useState } from 'react'\nexport default {} as InfoBoardPlugin`
    )
    try {
      expect(() => packPlugin(dir)).not.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('入口超过 2 MB 直接拒绝（运行时也会拒）', () => {
    const dir = pluginDir(`// ${'x'.repeat(MAX_ENTRY_BYTES + 10)}\nexport default 1`)
    try {
      expect(() => packPlugin(dir)).toThrow(/过大/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  /** 不致命但必须提醒：用了 invoke 却没声明 tauriCommands，装上去所有 invoke 都会被拒 */
  it('用 invoke 但没声明 tauriCommands → 给出 warning（不阻断打包）', () => {
    const dir = pluginDir(
      `import { invoke } from '@tauri-apps/api/core'\nexport const run = () => invoke('window_is_active')`
    )
    try {
      const { warnings } = packPlugin(dir)
      expect(warnings.some((w) => w.includes('tauriCommands'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('声明了 tauriCommands 时不产生该 warning', () => {
    const dir = pluginDir(
      `import { invoke } from '@tauri-apps/api/core'\nexport const run = () => invoke('window_is_active')`,
      { tauriCommands: ['window_is_active'] }
    )
    try {
      expect(packPlugin(dir).warnings).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('没用 invoke 的插件不产生 warning', () => {
    const dir = pluginDir(`import { useState } from 'react'\nexport default 1`)
    try {
      expect(packPlugin(dir).warnings).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
