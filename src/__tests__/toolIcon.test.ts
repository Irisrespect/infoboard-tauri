import { describe, it, expect } from 'vitest'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { isEmoji, ToolIcon, SVG_ICONS } from '../components/ToolSection'
import type { PluginManifest } from '../core/types'

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

describe('具名 SVG 图标真的会画出来（而不是变成看不见的空 svg）', () => {
  const manifest = (icon: string, color?: string): PluginManifest => ({
    id: 'test',
    name: '测试',
    section: 'tool',
    icon,
    color,
  })

  function render(icon: string, isActive: boolean, color?: string) {
    return renderToStaticMarkup(
      React.createElement(ToolIcon, {
        manifest: manifest(icon, color),
        isActive,
        onClick: () => {},
      })
    )
  }

  /** 网盘下载用的是这个图标 */
  it('cloud-download 已注册且能渲染出路径', () => {
    expect(SVG_ICONS['cloud-download']).toBeTruthy()
    const html = render('cloud-download', false, 'var(--accent)')
    // Lucide cloud-download 的三段路径
    expect(html).toContain('M12 13v8l-4-4')
    expect(html).toContain('m12 21 4-4')
    expect(html).toContain('M4.393 15.269')
  })

  /**
   * 回归：svg 是 `fill="none"` 的线性图标，**没有 stroke 就等于看不见**。
   * 未选中时用 manifest.color；外部插件的 color 一度会因为宿主不透传而丢失。
   */
  it('未选中时也有 stroke（没有 color 就退回 currentColor）', () => {
    expect(render('cloud-download', false, 'var(--accent)')).toContain('stroke:var(--accent)')
    expect(render('cloud-download', false)).toContain('stroke:currentColor')
  })

  it('选中时用主题强调色而不是不存在的变量', () => {
    const html = render('cloud-download', true)
    expect(html).toContain('stroke:var(--accent)')
    expect(html).not.toContain('--color-primary')
  })
})
