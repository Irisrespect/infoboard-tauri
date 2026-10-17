import { describe, it, expect } from 'vitest'
import { formatUvIndex } from '../plugins/weather/display'

describe('formatUvIndex（紫外线不再恒显示 --）', () => {
  it('有值时原样展示', () => {
    expect(formatUvIndex('3')).toBe('3')
    expect(formatUvIndex('11')).toBe('11')
  })

  it('缺字段 / 空串时显示「暂无」而不是 --', () => {
    expect(formatUvIndex(undefined)).toBe('暂无')
    expect(formatUvIndex(null)).toBe('暂无')
    expect(formatUvIndex('')).toBe('暂无')
    expect(formatUvIndex('   ')).toBe('暂无')
  })

  it('结果里不会出现 -- 占位符', () => {
    for (const v of [undefined, null, '', '   ']) {
      expect(formatUvIndex(v)).not.toBe('--')
    }
  })
})
