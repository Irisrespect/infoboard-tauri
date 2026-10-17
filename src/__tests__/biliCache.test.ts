import { describe, it, expect } from 'vitest'
import { selectEvictions, MAX_BILI_CACHE_ENTRIES } from '../plugins/dynamic-island/biliCache'

const NOW = 1_000_000

function entries(pairs: Array<[string, number]>): Array<[string, { expires: number }]> {
  return pairs.map(([k, expires]) => [k, { expires }])
}

describe('selectEvictions（bilibiliCache 只增不减）', () => {
  it('未达上限且无过期条目时不淘汰', () => {
    const e = entries([
      ['a', NOW + 1000],
      ['b', NOW + 2000],
    ])
    expect(selectEvictions(e, NOW, 100)).toEqual([])
  })

  it('达到上限时淘汰最早过期的条目，腾出写入位置', () => {
    // 上限 3，已有 3 条 → 写入第 4 条前必须淘汰 1 条
    const e = entries([
      ['oldest', NOW + 1000],
      ['middle', NOW + 2000],
      ['newest', NOW + 3000],
    ])
    expect(selectEvictions(e, NOW, 3)).toEqual(['oldest'])
  })

  it('优先淘汰已过期条目，不动仍然有效的', () => {
    const e = entries([
      ['stale-1', NOW - 5000],
      ['alive', NOW + 9000],
      ['stale-2', NOW - 1],
    ])
    // 3 条中 2 条过期 → 全淘汰，写入后仍远低于上限
    expect(selectEvictions(e, NOW, 3).sort()).toEqual(['stale-1', 'stale-2'])
  })

  it('过期条目足以腾出位置时不再多删（不误伤仍有效的条目）', () => {
    // 上限 3、已有 3 条（其中 1 条过期）：
    // 删掉过期的后 alive=2，写入新条目刚好 3 条 → 不该再删 early/late
    const e = entries([
      ['stale', NOW - 100],
      ['early', NOW + 1000],
      ['late', NOW + 5000],
    ])
    expect(selectEvictions(e, NOW, 3)).toEqual(['stale'])
  })

  it('过期条目不足以腾出位置时继续按时间淘汰', () => {
    // 上限 4、已有 5 条（其中 1 条过期）：
    // 删过期的后 alive=4，写入新条目会到 5 条 → 还需淘汰最早的 alive
    const e = entries([
      ['stale', NOW - 100],
      ['early', NOW + 1000],
      ['mid', NOW + 2000],
      ['later', NOW + 3000],
      ['latest', NOW + 5000],
    ])
    const out = selectEvictions(e, NOW, 4)
    expect(out).toContain('stale')
    expect(out).toContain('early')
    expect(out).not.toContain('latest')
    expect(out).toHaveLength(2)
  })

  it('恰好等于上限也触发淘汰（否则 set 之后会超限）', () => {
    const e = entries(
      Array.from(
        { length: MAX_BILI_CACHE_ENTRIES },
        (_, i) => [`k${i}`, NOW + i] as [string, number]
      )
    )
    const out = selectEvictions(e, NOW)
    expect(out).toHaveLength(1)
    expect(out[0]).toBe('k0')
  })

  it('空缓存不淘汰', () => {
    expect(selectEvictions([], NOW)).toEqual([])
  })

  it('淘汰数量刚好让写入后不超过上限', () => {
    const max = 5
    const e = entries(Array.from({ length: 9 }, (_, i) => [`k${i}`, NOW + i] as [string, number]))
    const out = selectEvictions(e, NOW, max)
    // 9 - 淘汰数 + 1(新写入) <= 5
    expect(9 - out.length + 1).toBeLessThanOrEqual(max)
    // 也不该多删
    expect(9 - out.length + 1).toBe(max)
  })
})
