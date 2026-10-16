import { describe, it, expect } from 'vitest'
import { describeError, toError } from '../core/ErrorBoundary'

describe('toError（组件可能 throw 任意值）', () => {
  it('Error 原样返回', () => {
    const e = new Error('boom')
    expect(toError(e)).toBe(e)
  })

  it('字符串 → Error', () => {
    expect(toError('炸了').message).toBe('炸了')
  })

  it('带 message 的对象 → Error 取 message', () => {
    expect(toError({ message: '对象里的消息' }).message).toBe('对象里的消息')
  })

  it('普通对象 → JSON 文本', () => {
    expect(toError({ code: 500 }).message).toContain('500')
  })

  it('undefined / null / 数字 → 可读文本，不抛错', () => {
    expect(toError(undefined).message).toBe('未知错误')
    expect(toError(null).message).toBe('null')
    expect(toError(42).message).toBe('42')
  })

  it('循环引用对象不会抛错', () => {
    const a: Record<string, unknown> = {}
    a.self = a
    expect(() => toError(a)).not.toThrow()
  })
})

describe('describeError（兜底界面展示用）', () => {
  it('标题取 message，详情取栈的前几行', () => {
    const err = new Error('渲染失败')
    const { title, detail } = describeError(err)
    expect(title).toBe('渲染失败')
    expect(detail.split('\n').length).toBeLessThanOrEqual(6)
  })

  it('空 message 回退到 name，再回退到"未知错误"', () => {
    expect(describeError(new Error('')).title).toBe('Error')
    const nameless = new Error('')
    nameless.name = ''
    expect(describeError(nameless).title).toBe('未知错误')
  })

  it('没有栈时 detail 为空串（界面据此隐藏代码块）', () => {
    const err = new Error('x')
    err.stack = ''
    expect(describeError(err).detail).toBe('')
  })
})
