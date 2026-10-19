/**
 * API 测活插件（plugins/api-probe）的"装上就能跑"回归测试
 *
 * 外部插件不在 tsconfig 的 include 里，`npm run build` 不会检查它 ——
 * 语法错、import 了白名单外的模块、调用了没声明的命令，都要等用户拖进去才暴露。
 * 这里把同样的检查提前到 CI。
 *
 * 这个插件是**启动器**：它自己不测活（插件沙箱既不能发网络请求也不能写文件，
 * 而测活工具的核心正是这两件事）。点了没反应是最难查的故障，所以把宿主那侧的
 * 接线也一起锁住。
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { transpilePluginSource, evaluatePluginSource, SHARED_MODULES } from '../core/pluginRuntime'
import { packPlugin } from '../../scripts/pack-plugin.mjs'

const APP_ROOT = process.cwd()
const PLUGIN_DIR = join(APP_ROOT, 'plugins', 'api-probe')

function readSource(): string {
  return readFileSync(join(PLUGIN_DIR, 'index.tsx'), 'utf8')
}

function readManifest(): {
  id: string
  name: string
  version: string
  tauriCommands?: string[]
  section: string
  icon: string
} {
  return JSON.parse(readFileSync(join(PLUGIN_DIR, 'manifest.json'), 'utf8'))
}

/** 源码里所有真正会执行的 invoke 命令名 */
function invokedCommands(source: string): string[] {
  const found = new Set<string>()
  const re = /\binvoke\s*(?:<[^<>]*>)?\s*\(\s*['"]([^'"]+)['"]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(source)) !== null) found.add(m[1])
  return [...found]
}

describe('api-probe 插件', () => {
  it('能用应用的真实运行时转译并加载', () => {
    const src = readSource()
    const code = transpilePluginSource(src, 'index.tsx')
    expect(code).toContain('apiprobe_app_launch')

    const mod = evaluatePluginSource(src, 'index.tsx', SHARED_MODULES)
    const plugin = (mod.default ?? mod.plugin) as {
      manifest: { id: string; section: string }
      Component: unknown
      onDestroy?: () => void
    }
    expect(plugin).toBeTruthy()
    expect(plugin.manifest.id).toBe('api-probe')
    expect(plugin.manifest.section).toBe('tool')
    expect(typeof plugin.Component).toBe('function')
    expect(typeof plugin.onDestroy).toBe('function')
  })

  it('源码 manifest 与 manifest.json 一致（id / 名称 / 版本 / 区域）', () => {
    const manifest = readManifest()
    const src = readSource()
    expect(src).toContain(`id: '${manifest.id}'`)
    expect(src).toContain(`name: '${manifest.name}'`)
    expect(src).toContain(`version: '${manifest.version}'`)
    expect(src).toContain(`section: '${manifest.section}'`)
  })

  /**
   * 工具区图标下那行字来自 `manifest.json` 的 `name`（`ToolIcon` 直接渲染它）。
   *
   * 这里刻意钉一个**短名**：工具区是 4 列网格、字号 `text-xs`，
   * 完整说明放在 `description` 和展开面板里，不挤在图标下面。
   */
  it('工具区显示名是 "API"', () => {
    expect(readManifest().name).toBe('API')
  })

  /**
   * 图标必须是宿主 `SVG_ICONS` 里注册过的具名图标。
   * 名字写错不会报错 —— 工具区会默默降级成一行灰色小字，最难查。
   */
  it('图标是宿主注册过的具名线性图标', () => {
    const icon = readManifest().icon
    const tool = readFileSync(join(APP_ROOT, 'src', 'components', 'ToolSection.tsx'), 'utf8')
    const registered = tool.includes(`'${icon}': (`) || new RegExp(`\\n\\s+${icon}: \\(`).test(tool)
    expect(registered, `SVG_ICONS 里没有注册 "${icon}"，工具区会显示成灰字`).toBe(true)
    expect(/^[a-z][a-z0-9-]*$/.test(icon), `"${icon}" 不是具名图标`).toBe(true)
  })

  it('每个 invoke 的命令都在 tauriCommands 里声明（否则运行时被拒）', () => {
    const declared = new Set(readManifest().tauriCommands ?? [])
    const used = invokedCommands(readSource())
    expect(used.length).toBeGreaterThan(0)

    const missing = used.filter((c) => !declared.has(c))
    expect(missing, `未声明的命令会让 invoke 直接失败: ${missing.join(', ')}`).toEqual([])
    const unused = [...declared].filter((c) => !used.includes(c))
    expect(unused, `manifest 里声明了但代码没用到: ${unused.join(', ')}`).toEqual([])
  })

  it('插件声明的自定义命令在宿主里真实注册过', () => {
    const lib = readFileSync(join(APP_ROOT, 'src-tauri', 'src', 'lib.rs'), 'utf8')
    const custom = (readManifest().tauriCommands ?? []).filter((c) => !c.includes(':'))
    expect(custom.length).toBeGreaterThan(0)
    for (const cmd of custom) {
      expect(lib, `lib.rs 的 generate_handler 里没有 ${cmd}`).toContain(cmd)
    }
  })

  /**
   * 点图标：配好了就直接开，没配好才展开面板。
   * 这条接线按 id 硬连，两边改名就会变成"点了没反应也没提示"。
   */
  it('宿主认识 api-probe，启动失败时回落到面板', () => {
    const tool = readFileSync(join(APP_ROOT, 'src', 'components', 'ToolSection.tsx'), 'utf8')
    expect(tool).toContain("pluginId === 'api-probe'")
    expect(tool).toContain('apiprobe_app_launch')
    // 失败要展开面板去配置，而不是弹个错误框就完了（用户没有别的地方能配）
    expect(tool).toMatch(/apiprobe_app_launch[\s\S]{0,200}setExpandedPluginId\('api-probe'\)/)
  })

  /** 手动指定路径的能力必须校验入口文件名，否则就成了"启动任意程序"的口子 */
  it('宿主只接受约定文件名的入口', () => {
    const companion = readFileSync(
      join(APP_ROOT, 'src-tauri', 'src', 'core', 'companion.rs'),
      'utf8'
    )
    expect(companion).toContain('api_probe.py')
    expect(companion, '没有校验文件名的话，可以指向任意脚本').toMatch(/name != spec\.entry/)
  })

  it('能打包成 .ibplugin 且包含入口', () => {
    const pkg = packPlugin(PLUGIN_DIR)
    expect(pkg.id).toBe('api-probe')
    expect(pkg.files).toEqual(['manifest.json', 'index.tsx'])
    expect(pkg.buffer.length).toBeLessThan(200 * 1024)
  })
})
