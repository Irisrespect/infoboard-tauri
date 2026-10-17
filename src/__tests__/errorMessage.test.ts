import { describe, it, expect } from 'vitest'
import { errorMessage } from '../core/errorMessage'

describe('errorMessage（不再渲染成 [object Object]）', () => {
  it('字符串原样返回（Tauri 的 Err(String) 就是这种）', () => {
    expect(errorMessage('未配置和风天气 API Key')).toBe('未配置和风天气 API Key')
  })

  it('Error 取 message', () => {
    expect(errorMessage(new Error('图片加载失败'))).toBe('图片加载失败')
  })

  it('message 为空的 Error 退回 name', () => {
    expect(errorMessage(new TypeError())).toBe('TypeError')
  })

  /**
   * 回归：`String(e)` 对对象型拒绝值会渲染成 "[object Object]"，
   * 用户和排查者都看不到原因。
   */
  it('对象型拒绝值不再变成 [object Object]', () => {
    const out = errorMessage({ message: '命令不存在', code: 404 })
    expect(out).not.toContain('[object Object]')
    expect(out).toContain('命令不存在')
    expect(out).toContain('404')
  })

  it('只有 code 没有 message 的对象也能读出信息', () => {
    expect(errorMessage({ code: 'E_FAIL' })).not.toContain('[object Object]')
  })

  it('{ error: ... } / { msg: ... } 形状也支持', () => {
    expect(errorMessage({ error: '内部错误' })).toBe('内部错误')
    expect(errorMessage({ msg: '消息' })).toBe('消息')
  })

  it('无已知字段的对象退化为 JSON', () => {
    expect(errorMessage({ a: 1 })).toBe('{"a":1}')
  })

  it('循环引用对象不抛错', () => {
    const a: Record<string, unknown> = {}
    a.self = a
    expect(() => errorMessage(a)).not.toThrow()
    expect(errorMessage(a)).not.toContain('[object Object]')
  })

  it('null / undefined / 数字 / 布尔 都有可读结果', () => {
    expect(errorMessage(null)).toBe('null')
    expect(errorMessage(undefined)).toBe('undefined')
    expect(errorMessage(500)).toBe('500')
    expect(errorMessage(false)).toBe('false')
  })

  it('永远不返回 Could not clone / 空串', () => {
    for (const v of [null, undefined, {}, new Error(), 'x', 0]) {
      expect(errorMessage(v)).not.toBe('')
    }
  })
})
