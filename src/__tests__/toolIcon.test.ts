import { describe, it, expect } from 'vitest'
import { isEmoji } from '../components/ToolSection'

describe('isEmoji（原先按 length<=2 判断，组合 emoji 判错）', () => {
  it('普通单码元 emoji 仍是 emoji', () => {
    expect(isEmoji('🔧')).toBe(true)
    expect(isEmoji('👋')).toBe(true)
    expect(isEmoji('💻')).toBe(true)
  })

  /** 回归：这些长度 4~7 个 UTF-16 码元，旧实现全部判成"不是 emoji" */
  it('带变体选择符 / 肤色修饰符 / ZWJ 的组合 emoji 也判为 emoji', () => {
    expect(isEmoji('👋🏽')).toBe(true) // 肤色修饰符
    expect(isEmoji('🏳️‍🌈')).toBe(true) // ZWJ 序列（彩虹旗）
    expect(isEmoji('👨‍👩‍👧')).toBe(true) // ZWJ 家庭
    expect(isEmoji('☺️')).toBe(true) // 变体选择符 FE0F
    expect(isEmoji('🇨🇳')).toBe(true) // 区域指示符（国旗）
  })

  /** 回归：两个汉字长度也是 2 且不以小写字母开头，旧实现误判为 emoji */
  it('中文文本不再被误判为 emoji', () => {
    expect(isEmoji('设置')).toBe(false)
    expect(isEmoji('工具')).toBe(false)
    expect(isEmoji('笔记')).toBe(false)
  })

  it('SVG 图标名不是 emoji', () => {
    expect(isEmoji('camera')).toBe(false)
    expect(isEmoji('settings')).toBe(false)
    expect(isEmoji('languages')).toBe(false)
  })

  it('空串 / 纯空白 / 空图标不是 emoji', () => {
    expect(isEmoji('')).toBe(false)
    expect(isEmoji('   ')).toBe(false)
    expect(isEmoji('\n')).toBe(false)
  })

  it('首尾空白会被忽略', () => {
    expect(isEmoji(' 🔧 ')).toBe(true)
  })

  it('emoji + 文字混合不是 emoji（应走未知图标分支）', () => {
    expect(isEmoji('🔧 工具')).toBe(false)
    expect(isEmoji('x🔧')).toBe(false)
  })

  it('数字 / 单个字母不是 emoji', () => {
    expect(isEmoji('1')).toBe(false)
    expect(isEmoji('a')).toBe(false)
  })
})
