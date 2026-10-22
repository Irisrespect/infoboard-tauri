/**
 * 插件图标契约：`manifest.icon` 必须能被工具区画出来
 *
 * `ToolIcon` 的渲染分支是：
 *   1. `isEmoji(icon)` → 当 emoji 画
 *   2. `SVG_ICONS[icon]` → 画具名 SVG
 *   3. 都不是 → **把 icon 字符串当灰色文字画**（"whale" 就显示成 whale 四个字母）
 *
 * 第 3 条是静默降级：不报错、不警告，只有肉眼能发现。所以这里钉死：
 * 每个插件的 icon 要么是 emoji，要么真的在 SVG_ICONS 里注册过。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// ToolSection 里的图标点击会 invoke，测试不需要真实现
vi.mock('@tauri-apps/api/core', () => ({ invoke: async () => undefined }))

import { SVG_ICONS, isEmoji } from '../components/ToolSection'

interface Manifest {
  id?: string
  icon?: string
}

function readManifests(): { dir: string; manifest: Manifest }[] {
  const pluginsDir = join(process.cwd(), 'plugins')
  return readdirSync(pluginsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => {
      const path = join(pluginsDir, entry.name, 'manifest.json')
      if (!existsSync(path)) return null
      try {
        return { dir: entry.name, manifest: JSON.parse(readFileSync(path, 'utf8')) as Manifest }
      } catch {
        return null
      }
    })
    .filter((m): m is { dir: string; manifest: Manifest } => m !== null)
}

describe('插件图标契约', () => {
  const items = readManifests()

  it('至少扫到一个插件（保证下面的断言不是空过）', () => {
    expect(items.length).toBeGreaterThan(0)
  })

  it('每个插件的 icon 都能被画出来（emoji 或已注册的具名图标）', () => {
    const broken = items
      .filter(({ manifest }) => {
        const icon = manifest.icon
        if (typeof icon !== 'string' || !icon.trim()) return true
        return !isEmoji(icon) && !(icon in SVG_ICONS)
      })
      .map(({ dir, manifest }) => `${dir}: "${manifest.icon}"`)

    expect(
      broken,
      `这些插件的图标既不是 emoji、也没在 SVG_ICONS 里注册：\n${broken.join('\n')}`
    ).toEqual([])
  })

  it('DeepSeek 用的是自绘的 whale，而不是 emoji', () => {
    const deepseek = items.find(({ dir }) => dir === 'deepseek')
    expect(deepseek, '没找到 plugins/deepseek/manifest.json').toBeTruthy()
    expect(deepseek?.manifest.icon).toBe('whale')
    expect('whale' in SVG_ICONS, 'SVG_ICONS 里没有 whale').toBe(true)
  })

  it('whale 的两条 path 都在 viewBox 范围内（0~24，留 1px 描边余量）', () => {
    // 直接从源码里取数字，避免为了看一眼坐标去渲染
    const node = SVG_ICONS.whale as unknown
    const text = JSON.stringify(node)
    const nums = text.match(/-?\d+(\.\d+)?/g) ?? []
    const xs: number[] = []
    const ys: number[] = []
    // path 里是 "x y" 成对出现的绝对坐标 + 曲线控制点，成对取即可（M/L/C 都是成对）
    for (let i = 0; i + 1 < nums.length; i += 2) {
      xs.push(Number(nums[i]))
      ys.push(Number(nums[i + 1]))
    }
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(1)
    expect(Math.max(...xs)).toBeLessThanOrEqual(23)
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(1)
    expect(Math.max(...ys)).toBeLessThanOrEqual(23)
  })
})
