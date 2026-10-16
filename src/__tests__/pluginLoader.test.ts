import { describe, it, expect, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

import { fileNameOf } from '../core/PluginLoader'

// 用 join 拼 Windows 路径，避免源码里反斜杠转义出错
const win = (...parts: string[]) => parts.join('\\')

describe('fileNameOf', () => {
  it('Windows 反斜杠路径', () => {
    expect(fileNameOf(win('C:', 'Users', 'a', 'AppData', 'Roaming', 'plugins', 'p', 'index.tsx'))).toBe(
      'index.tsx'
    )
  })

  it('正斜杠与混合分隔符', () => {
    expect(fileNameOf('/a/b/c.tsx')).toBe('c.tsx')
    expect(fileNameOf(win('C:', 'a/b', 'c.tsx'))).toBe('c.tsx')
  })

  it('无分隔符 / 空串回退', () => {
    expect(fileNameOf('c.tsx')).toBe('c.tsx')
    expect(fileNameOf('')).toBe('index.tsx')
  })
})
