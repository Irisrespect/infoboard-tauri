import { describe, it, expect } from 'vitest'
import {
  QWEATHER_KEY_PLACEHOLDER,
  SECRET_NAME_NIUTRANS,
  SECRET_NAME_QWEATHER,
} from '../plugins/settings/secrets'

/**
 * 前后端契约：Key 占位符和凭据名必须两边一致。
 * 不一致时天气请求会把字面量 `{{QWEATHER_KEY}}` 当成真 Key 发出去（静默 401）。
 * 这里直接读 Rust 源码比对——测试文件自身不含这些字面量，不会自命中。
 */
const rustCoreSources = import.meta.glob('../../src-tauri/src/core/*.rs', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

function rustSource(fileName: string): string {
  const key = Object.keys(rustCoreSources).find((path) => path.endsWith(`/${fileName}`))
  if (!key) {
    throw new Error(
      `找不到 Rust 源文件 ${fileName}，已加载: ${Object.keys(rustCoreSources).join(', ')}`
    )
  }
  return rustCoreSources[key]
}

/** 取出 Rust 里 `const NAME: &str = "值";` 的字符串值 */
function rustStrConst(source: string, constName: string): string | null {
  const re = new RegExp(`const\\s+${constName}\\s*:\\s*&str\\s*=\\s*"([^"]*)"`)
  return source.match(re)?.[1] ?? null
}

describe('凭据契约（前端 ↔ Rust）', () => {
  it('能读到 Rust 源码（保证下面的断言不是空过）', () => {
    expect(Object.keys(rustCoreSources).length).toBeGreaterThan(0)
  })

  it('天气 Key 占位符与 core/http_proxy.rs 一致', () => {
    const declared = rustStrConst(rustSource('http_proxy.rs'), 'QWEATHER_KEY_PLACEHOLDER')
    expect(declared).toBe(QWEATHER_KEY_PLACEHOLDER)
  })

  it('凭据名与 core/secrets.rs 一致', () => {
    const src = rustSource('secrets.rs')
    expect(rustStrConst(src, 'NAME_QWEATHER')).toBe(SECRET_NAME_QWEATHER)
    expect(rustStrConst(src, 'NAME_NIUTRANS')).toBe(SECRET_NAME_NIUTRANS)
  })

  it('白名单必须包含前端用到的两个凭据名', () => {
    const src = rustSource('secrets.rs')
    const line = src.split('\n').find((l) => l.includes('ALLOWED_NAMES') && l.includes('&['))
    expect(line, '没找到 ALLOWED_NAMES 定义').toBeTruthy()
    expect(line).toContain('NAME_QWEATHER')
    expect(line).toContain('NAME_NIUTRANS')
  })
})
