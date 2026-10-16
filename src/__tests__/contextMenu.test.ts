import { describe, it, expect } from 'vitest'
import {
  clampMenuPosition,
  isMenuCloseKey,
  MENU_MARGIN,
  MENU_SIZE,
} from '../components/contextMenu'

const viewport = { width: 800, height: 600 }

describe('clampMenuPosition（右键菜单不得超出可视区）', () => {
  it('中间位置原样保留', () => {
    expect(clampMenuPosition({ x: 300, y: 200 }, viewport)).toEqual({ x: 300, y: 200 })
  })

  /** 回归：右下角右键时菜单会超出窗口，菜单项点不到 */
  it('右下角被钳制到可视区内', () => {
    const p = clampMenuPosition({ x: 795, y: 595 }, viewport)
    expect(p.x).toBe(viewport.width - MENU_SIZE.width - MENU_MARGIN)
    expect(p.y).toBe(viewport.height - MENU_SIZE.height - MENU_MARGIN)
    expect(p.x + MENU_SIZE.width).toBeLessThanOrEqual(viewport.width)
    expect(p.y + MENU_SIZE.height).toBeLessThanOrEqual(viewport.height)
  })

  it('左上角负坐标被钳制到边距', () => {
    expect(clampMenuPosition({ x: -50, y: -50 }, viewport)).toEqual({
      x: MENU_MARGIN,
      y: MENU_MARGIN,
    })
  })

  it('窗口比菜单还小时仍给出合法（非负）坐标', () => {
    const tiny = { width: 100, height: 80 }
    const p = clampMenuPosition({ x: 50, y: 50 }, tiny)
    expect(p.x).toBeGreaterThanOrEqual(MENU_MARGIN)
    expect(p.y).toBeGreaterThanOrEqual(MENU_MARGIN)
  })
})

describe('isMenuCloseKey', () => {
  it('Escape / Esc 都算关闭', () => {
    expect(isMenuCloseKey('Escape')).toBe(true)
    expect(isMenuCloseKey('Esc')).toBe(true)
  })

  it('其它按键不关', () => {
    for (const k of ['Enter', 'a', 'ArrowDown', ' ']) {
      expect(isMenuCloseKey(k)).toBe(false)
    }
  })
})
