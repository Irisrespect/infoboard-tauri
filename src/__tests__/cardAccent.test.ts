import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// useThemeColors 依赖 themeColorStore，而它在**模块顶层**就 new MutationObserver /
// 读 getComputedStyle，所以 DOM 桩必须在 import 之前装好（vi.hoisted 先于所有 import）。
vi.hoisted(() => {
  const store = new Map<string, string>()
  const g = globalThis as Record<string, unknown>
  g.document ??= { documentElement: {} }
  g.getComputedStyle ??= () => ({ getPropertyValue: () => '' })
  g.MutationObserver ??= class {
    observe() {}
    disconnect() {}
    takeRecords() {
      return []
    }
  }
  g.localStorage ??= {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  }
})

const invokeMock = vi.fn((..._args: unknown[]) => Promise.resolve(null))
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: () => Promise.resolve(() => {}),
  emit: () => Promise.resolve(),
}))

import { WeatherCard } from '../plugins/weather/WeatherCard'
import { TodoCard } from '../plugins/todo/TodoCard'
import { AccentProvider, useAccent, FALLBACK_ACCENT } from '../hooks/useAccent'
// 用 Vite 的 ?raw 读取源码文本做静态断言（仓库既有做法，不依赖 Node 类型）
import weatherCardSrc from '../plugins/weather/WeatherCard.tsx?raw'
import todoCardSrc from '../plugins/todo/TodoCard.tsx?raw'

const manifest = {
  id: 'test-plugin',
  name: '测试',
  version: '1.0.0',
  section: 'info' as const,
  icon: '🔧',
  entry: 'index.tsx',
}

/** 直接消费 Context 的探针组件 */
function Probe() {
  return React.createElement('span', null, useAccent())
}

beforeEach(() => {
  invokeMock.mockClear()
})

describe('useAccent 契约', () => {
  it('无 Provider 时返回兜底主题色', () => {
    const html = renderToStaticMarkup(React.createElement(Probe))
    expect(html).toContain(FALLBACK_ACCENT)
  })

  it('Provider 的值会传下去（替换掉模块级可变变量后的核心行为）', () => {
    const html = renderToStaticMarkup(
      React.createElement(AccentProvider, { value: '#ABCDEF' }, React.createElement(Probe))
    )
    expect(html).toContain('#ABCDEF')
    expect(html).not.toContain(FALLBACK_ACCENT)
  })

  it('嵌套时以内层为准', () => {
    const html = renderToStaticMarkup(
      React.createElement(
        AccentProvider,
        { value: '#111111' },
        React.createElement(AccentProvider, { value: '#222222' }, React.createElement(Probe))
      )
    )
    expect(html).toContain('#222222')
  })

  it('兜底色是合法十六进制（不是 undefined）', () => {
    expect(FALLBACK_ACCENT).toMatch(/^#[0-9a-fA-F]{6}$/)
  })
})

/**
 * 回归：主题色原先走模块级可变 `let ACCENT` + 渲染期赋值（渲染期副作用，
 * 并发渲染下会撕裂、同卡片渲染两份时互相覆盖）。现在改为 Context，必须保证
 * **所有分支**（含 early return 的 Loading / Error / Empty）都在 Provider 内，
 * 否则子组件会静默退回兜底色 —— 而"静默退回"正是最难发现的那类 bug。
 */
describe('卡片把内容包在 AccentProvider 内', () => {
  const cards: Array<[string, React.ComponentType<{ manifest: typeof manifest }>]> = [
    ['WeatherCard', WeatherCard],
    ['TodoCard', TodoCard],
  ]

  it.each(cards)('%s 能渲染且不抛错', (_name, Card) => {
    expect(() => renderToStaticMarkup(React.createElement(Card, { manifest }))).not.toThrow()
  })

  it('两个卡片都不再依赖模块级可变 ACCENT', () => {
    const sources: Array<[string, string]> = [
      ['WeatherCard.tsx', weatherCardSrc],
      ['TodoCard.tsx', todoCardSrc],
    ]
    for (const [name, src] of sources) {
      expect(src, `${name} 不应再有模块级 let ACCENT`).not.toMatch(/^let ACCENT/m)
      // 渲染期给模块级变量赋值是原来的写法，必须绝迹
      expect(src, `${name} 不应在渲染期改写 ACCENT`).not.toMatch(/^\s*ACCENT = accent\s*$/m)
      expect(src, `${name} 应使用 useAccent()`).toContain('useAccent()')
      expect(src, `${name} 应提供 AccentProvider`).toContain('AccentProvider')
    }
  })
})
