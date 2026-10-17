/**
 * 右键菜单定位（纯函数，便于单测）
 *
 * 原先直接用鼠标坐标定位：在窗口右下角右键时菜单会超出可视区、点不到菜单项。
 */

export interface Point {
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

/** 菜单尺寸估算（minWidth 140 + padding/border，3 项按钮） */
export const MENU_SIZE: Size = { width: 152, height: 120 }

/** 与窗口边缘至少留出的间距 */
export const MENU_MARGIN = 4

/**
 * 把菜单位置钳制在可视区内。
 *
 * @param requested 鼠标位置
 * @param viewport  可视区尺寸（通常 window.innerWidth / innerHeight）
 * @param menu      菜单尺寸（默认 MENU_SIZE）
 */
export function clampMenuPosition(requested: Point, viewport: Size, menu: Size = MENU_SIZE): Point {
  const maxX = Math.max(MENU_MARGIN, viewport.width - menu.width - MENU_MARGIN)
  const maxY = Math.max(MENU_MARGIN, viewport.height - menu.height - MENU_MARGIN)
  return {
    x: Math.min(Math.max(requested.x, MENU_MARGIN), maxX),
    y: Math.min(Math.max(requested.y, MENU_MARGIN), maxY),
  }
}

/** Esc 关闭菜单（也接受 'Esc' 这种旧写法） */
export function isMenuCloseKey(key: string): boolean {
  return key === 'Escape' || key === 'Esc'
}
