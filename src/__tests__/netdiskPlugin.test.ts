/**
 * 网盘下载插件（plugins/netdisk）的"装上就能跑"回归测试
 *
 * 外部插件不在 `tsconfig` 的 include 里（`include: ["src"]`），所以 `npm run build`
 * 不会检查它 —— 语法错、import 了白名单外的模块、调用了没声明的命令，这些都要等
 * 用户把插件拖进去才会暴露。这个测试把同样的检查提前到 CI：
 *
 * 1. 用**应用真实使用的**转译 + 执行链路跑一遍入口（`transpilePluginSource` /
 *    `evaluatePluginSource`），语法错误和违规 import 会在这里炸
 * 2. 源码里每个 `invoke('xxx')` 都必须在 manifest.json 的 tauriCommands 里声明，
 *    否则运行时会 fail-closed 直接拒绝
 * 3. 这个插件**不自己下载**：点图标时由宿主直接拉起独立软件。那条链路是按 id 硬连的，
 *    两边必须同时对得上，否则会出现"点了没反应也没报错"这种最难查的问题
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { transpilePluginSource, evaluatePluginSource, SHARED_MODULES } from '../core/pluginRuntime'
import { packPlugin } from '../../scripts/pack-plugin.mjs'

const APP_ROOT = process.cwd()
const PLUGIN_DIR = join(APP_ROOT, 'plugins', 'netdisk')

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

describe('netdisk 插件', () => {
  it('能用应用的真实运行时转译并加载', () => {
    const src = readSource()
    // 转译失败会抛 PluginRuntimeError（含具体行列）
    const code = transpilePluginSource(src, 'index.tsx')
    expect(code).toContain('netdisk_app_launch')

    const mod = evaluatePluginSource(src, 'index.tsx', SHARED_MODULES)
    const plugin = (mod.default ?? mod.plugin) as {
      manifest: { id: string; section: string }
      Component: unknown
      onDestroy?: () => void
    }
    expect(plugin).toBeTruthy()
    expect(plugin.manifest.id).toBe('netdisk')
    expect(plugin.manifest.section).toBe('tool')
    expect(typeof plugin.Component).toBe('function')
    // 顶层不能有副作用，onDestroy 必须存在（重新加载插件时会调用）
    expect(typeof plugin.onDestroy).toBe('function')
  })

  it('源码 manifest 与 manifest.json 一致（id / 名称 / 版本 / 区域）', () => {
    const manifest = readManifest()
    const src = readSource()
    expect(src).toContain(`id: '${manifest.id}'`)
    expect(src).toContain(`name: '${manifest.name}'`)
    expect(src).toContain(`version: '${manifest.version}'`)
    expect(src).toContain(`section: '${manifest.section}'`)
    expect(manifest.icon.length).toBeGreaterThan(0)
  })

  /**
   * 图标必须是宿主 `SVG_ICONS` 里注册过的具名图标。
   *
   * 名字写错不会报错 —— 工具区会默默降级成一行灰色小字（连图标都没有），
   * 这种"看起来像样式问题"的毛病最难查，所以在 CI 里挡住。
   */
  it('图标是宿主注册过的具名 SVG（写错了会静默降级成灰字）', () => {
    const icon = readManifest().icon
    const tool = readFileSync(join(APP_ROOT, 'src', 'components', 'ToolSection.tsx'), 'utf8')

    // 注册表里的键写法有两种：'cloud-download': ( 或 camera: (
    const registered = tool.includes(`'${icon}': (`) || new RegExp(`\\n\\s+${icon}: \\(`).test(tool)
    expect(registered, `SVG_ICONS 里没有注册 "${icon}"，工具区会显示成灰字`).toBe(true)

    // 具名图标（线性图标），不是 emoji —— 工具区其它插件都走这条
    expect(/^[a-z][a-z0-9-]*$/.test(icon), `"${icon}" 不是具名图标`).toBe(true)
  })

  /**
   * 激活态的颜色必须指向真实存在的 CSS 变量。
   *
   * 回归：这里原来写的是 `--color-primary` / `--color-text-secondary`，
   * 而工程里从来没定义过它们（CSS 里只有 --accent / --text-secondary）。
   * `color` 写错只是不变色，但 `stroke` 会因 var() 求值失败回落到初始值 `none`
   * —— 点中的插件图标会**整个消失**。
   */
  it('工具图标的激活色指向真实存在的 CSS 变量', () => {
    const tool = readFileSync(join(APP_ROOT, 'src', 'components', 'ToolSection.tsx'), 'utf8')
    // 只看代码里引用的（注释里会提到这些名字，所以带上引号匹配）
    const referenced = tool.match(/'var\(--[a-z-]+\)'/g) ?? []
    expect(referenced.length).toBeGreaterThan(0)

    const globals = readFileSync(join(APP_ROOT, 'src', 'styles', 'globals.css'), 'utf8')
    for (const quoted of referenced) {
      const name = quoted.slice(1, -1) // var(--xxx)
      expect(globals, `globals.css 里没有定义 ${name}`).toContain(`${name.slice(4, -1)}:`)
    }
  })

  /**
   * 外部插件的 `color` 必须能从 manifest.json 一路传到前端。
   *
   * 回归：宿主那份 Rust `PluginManifest` 结构体原来没有 color 字段，
   * manifest.json 里写了会被 serde 静默丢掉。具名 SVG 图标在**未选中**时
   * 用 color 当 stroke，拿不到就是 `stroke: undefined` → 图标整个看不见。
   */
  it('宿主透传 manifest 的 color，前端也有兜底', () => {
    const loader = readFileSync(join(APP_ROOT, 'src-tauri', 'src', 'plugins', 'loader.rs'), 'utf8')
    const i = loader.indexOf('pub struct PluginManifest')
    const structBody = loader.slice(i, loader.indexOf('}', i))
    expect(structBody, 'loader 的 PluginManifest 没有 color 字段，会被 serde 丢掉').toContain(
      'pub color'
    )

    // 前端：没给 color 时不能留空 stroke
    const tool = readFileSync(join(APP_ROOT, 'src', 'components', 'ToolSection.tsx'), 'utf8')
    expect(tool).toContain("manifest.color || 'currentColor'")
  })

  it('每个 invoke 的命令都在 tauriCommands 里声明（否则运行时被拒）', () => {
    const declared = new Set(readManifest().tauriCommands ?? [])
    const used = invokedCommands(readSource())

    expect(used.length).toBeGreaterThan(0)
    const missing = used.filter((c) => !declared.has(c))
    expect(missing, `未声明的命令会让 invoke 直接失败: ${missing.join(', ')}`).toEqual([])

    // 反向检查：声明了却没用到，说明 manifest 和代码已经不同步
    const unused = [...declared].filter((c) => !used.includes(c))
    expect(unused, `manifest 里声明了但代码没用到: ${unused.join(', ')}`).toEqual([])
  })

  /**
   * 点图标 → 直接启动，不展开中间面板（和截图插件同一套做法）。
   * 这条链路两边都硬编码了 id，任何一边改名都会变成"点了没反应"。
   */
  it('宿主认识 netdisk，点图标直接启动而不是展开面板', () => {
    const tool = readFileSync(join(APP_ROOT, 'src', 'components', 'ToolSection.tsx'), 'utf8')
    expect(tool).toContain("pluginId === 'netdisk'")
    expect(tool).toContain('netdisk_app_launch')
    // 启动失败要让用户看得见（最常见原因：本机没装 Python）
    expect(tool).toContain('plugin:dialog|message')
  })

  it('宿主弹错误框的能力已开放（少了它失败时会静默）', () => {
    const caps = readFileSync(join(APP_ROOT, 'src-tauri', 'capabilities', 'default.json'), 'utf8')
    expect(caps).toContain('dialog:allow-message')
  })

  it('插件声明的自定义命令在宿主里真实注册过', () => {
    const lib = readFileSync(join(APP_ROOT, 'src-tauri', 'src', 'lib.rs'), 'utf8')
    const manifest = readManifest()
    // 带 plugin: 前缀的是 Tauri 插件命令，不在 generate_handler 里
    const custom = (manifest.tauriCommands ?? []).filter((c) => !c.includes(':'))
    expect(custom.length).toBeGreaterThan(0)
    for (const cmd of custom) {
      expect(lib, `lib.rs 的 generate_handler 里没有 ${cmd}`).toContain(cmd)
    }
  })

  it('能打包成 .ibplugin 且包含入口', () => {
    const pkg = packPlugin(PLUGIN_DIR)
    expect(pkg.id).toBe('netdisk')
    expect(pkg.files).toEqual(['manifest.json', 'index.tsx'])
    // 这个插件现在很薄（只是个启动器），顺手把"又变胖"也拦住：
    // 真要下载逻辑，应该放进独立软件而不是塞回插件
    expect(pkg.buffer.length).toBeLessThan(200 * 1024)
  })
})
