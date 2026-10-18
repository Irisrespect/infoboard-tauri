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
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { transpilePluginSource, evaluatePluginSource, SHARED_MODULES } from '../core/pluginRuntime'
import { packPlugin } from '../../scripts/pack-plugin.mjs'
import {
  detectAdapter,
  findUnsupported,
  fmtEta,
  fmtSize,
  safeName,
  acwScV2,
  allocateConnections,
  pickRelinkTargets,
  cookieDiagnosis,
} from '../../plugins/netdisk/index'

const PLUGIN_DIR = join(process.cwd(), 'plugins', 'netdisk')

function readSource(): string {
  return readFileSync(join(PLUGIN_DIR, 'index.tsx'), 'utf8')
}

function readManifest(): {
  id: string
  name: string
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
    expect(code).toContain('netdisk_http_request')

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

  it('源码 manifest 与 manifest.json 的 id / 名称 / 版本一致', () => {
    const manifest = readManifest()
    const src = readSource()
    expect(src).toContain(`id: '${manifest.id}'`)
    expect(src).toContain(`name: '${manifest.name}'`)
    expect(src).toContain(`section: 'tool'`)
    expect(manifest.icon.length).toBeGreaterThan(0)
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

  it('能打包成 .ibplugin 且包含入口', () => {
    const pkg = packPlugin(PLUGIN_DIR)
    expect(pkg.id).toBe('netdisk')
    expect(pkg.files).toEqual(['manifest.json', 'index.tsx'])
    // 入口体积上限 2MB，别把整个站点数据塞进单文件插件
    expect(pkg.buffer.length).toBeLessThan(2 * 1024 * 1024)
  })
})

describe('netdisk 插件的纯逻辑', () => {
  it('网盘识别：已知网盘走对应适配器，未知 http(s) 走直链兜底', () => {
    expect(detectAdapter('https://pan.quark.cn/s/abcd1234')?.id).toBe('quark')
    expect(detectAdapter('https://www.lanzoui.com/iabc123')?.id).toBe('lanzou')
    expect(detectAdapter('https://pan.baidu.com/s/1abcdEFG')?.id).toBe('baidu')
    expect(detectAdapter('https://example.com/a/b.zip')?.id).toBe('direct')
    expect(detectAdapter('ftp://example.com/x')).toBeNull()
    expect(detectAdapter('')).toBeNull()
  })

  /**
   * 并发策略必须按网盘区分：百度是"账号级限速 + 并发会触发惩罚"，
   * 给它开多线程会害了用户（可能被限速几小时到几天）
   */
  it('并发上限按网盘区分：百度锁 1 路，夸克可多路', () => {
    expect(detectAdapter('https://pan.baidu.com/s/1abcdEFG')?.maxConnections).toBe(1)
    expect(detectAdapter('https://pan.quark.cn/s/abcd1234')?.maxConnections).toBe(64)
    expect(detectAdapter('https://www.lanzoui.com/iabc123')?.maxConnections).toBe(32)
    // 直链交给用户设置，不额外限制
    expect(detectAdapter('https://example.com/a.zip')?.maxConnections).toBeUndefined()
  })

  /** 回归：没接入的网盘不能被当成直链去"下载"一个 HTML 页面 */
  it('未接入的网盘会被明确拦下，而不是落到直链兜底', () => {
    const alipan = findUnsupported('https://www.alipan.com/s/abcdef')
    expect(alipan?.name).toBe('阿里云盘')
    expect(alipan?.why).toContain('refresh_token')

    expect(findUnsupported('https://www.123pan.com/s/abc')?.name).toBe('123 云盘')
    expect(findUnsupported('https://cloud.189.cn/web/share?code=x')?.name).toBe('天翼云盘')
    expect(findUnsupported('https://drive.uc.cn/s/abc')?.name).toBe('UC 网盘')
    expect(findUnsupported('https://115.com/s/abc')?.name).toBe('115 网盘')

    // 已接入的和普通直链不该被误伤
    expect(findUnsupported('https://pan.quark.cn/s/abcd')).toBeNull()
    expect(findUnsupported('https://example.com/file.zip')).toBeNull()
  })

  it('体积/时间格式化', () => {
    expect(fmtSize(0)).toBe('—')
    expect(fmtSize(512)).toBe('512 B')
    expect(fmtSize(1536)).toBe('1.5 KB')
    expect(fmtSize(1024 * 1024 * 3)).toBe('3.0 MB')
    expect(fmtEta(0, 100, 0)).toBe('')
    expect(fmtEta(90, 100, 10)).toBe('1 秒')
    expect(fmtEta(0, 600, 10)).toBe('1 分钟')
    expect(fmtEta(0, 72000, 10)).toBe('2.0 小时')
  })

  it('文件名清洗与 Rust 侧一致', () => {
    expect(safeName('a/b\\c:d*e?.txt')).toBe('a_b_c_d_e_.txt')
    expect(safeName('   ')).toBe('unnamed')
  })

  /** acw_sc__v2 解挑战：结构错了蓝奏云整条链路都不通 */
  it('acw_sc__v2 解出的是一段固定长度的十六进制串', () => {
    const arg1 = 'A1B2C3D4E5F60718293A4B5C6D7E8F9012345678'
    const out = acwScV2(arg1)
    expect(out).toMatch(/^[0-9a-f]{40}$/)
    // 同一个输入必须稳定
    expect(acwScV2(arg1)).toBe(out)
    // 换一个输入必须换一个结果
    expect(acwScV2('1234567890ABCDEF1234567890ABCDEF12345678')).not.toBe(out)
  })

  /**
   * 连接预算分配：夸克按**账号**限制总连接数（社区实测 512 为最优总量），
   * 所以一次排多个文件时不能每个都开满，否则配额被摊薄、还容易撞上限
   */
  describe('allocateConnections', () => {
    it('单个文件保持用户设置不变', () => {
      expect(allocateConnections([123], 64)).toEqual([64])
    })

    it('按大小比例分配，大文件多给小文件保底', () => {
      const got = allocateConnections([900 * 1024 * 1024, 100 * 1024 * 1024], 512)
      expect(got[0]).toBeGreaterThan(got[1])
      expect(got[0] + got[1]).toBeLessThanOrEqual(512)
      expect(got[1]).toBeGreaterThanOrEqual(4)
    })

    it('总和不超过预算', () => {
      const got = allocateConnections([1024, 1024, 1024], 512)
      expect(got.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(512)
    })

    it('上限是用户设的单文件并发数', () => {
      const got = allocateConnections([10 * 1024 * 1024 * 1024, 1], 16)
      for (const v of got) expect(v).toBeLessThanOrEqual(16)
    })

    it('下限优先于预算：小文件也要下得动', () => {
      const sizes = new Array(200).fill(1024)
      const got = allocateConnections(sizes, 16, 512, 4)
      expect(got).toHaveLength(200)
      for (const v of got) expect(v).toBeGreaterThanOrEqual(4)
    })

    it('大小未知时退回平分而不是饿死', () => {
      const got = allocateConnections([0, 0, 0, 0], 64, 512)
      for (const v of got) {
        expect(v).toBeGreaterThanOrEqual(4)
        expect(v).toBeLessThanOrEqual(64)
      }
    })

    it('空输入与非法上限不会炸', () => {
      expect(allocateConnections([], 64)).toEqual([])
      expect(allocateConnections([100, 100], 0)).toEqual([1, 1])
    })
  })

  /**
   * 直链自愈的触发条件。轮询 800ms 一次，这里选错会导致：
   * 漏掉 → 任务白等到超时失败；重复 → 对同一个任务猛发换链请求
   */
  describe('pickRelinkTargets', () => {
    const sources: Record<string, unknown> = { 'dl-1': { adapterId: 'quark' } }

    it('挑出停在 expired 且有来源的任务', () => {
      const jobs = [
        { id: 'dl-1', state: 'expired' },
        { id: 'dl-2', state: 'running' },
        { id: 'dl-3', state: 'done' },
      ]
      const known = { ...sources, 'dl-2': {} }
      expect(pickRelinkTargets(jobs, known, new Set())).toEqual(['dl-1'])
    })

    it('不知道来源的任务不发起换链（换不了，交给后端超时）', () => {
      expect(pickRelinkTargets([{ id: 'dl-9', state: 'expired' }], sources, new Set())).toEqual([])
    })

    it('正在换链的任务不重复发起', () => {
      expect(
        pickRelinkTargets([{ id: 'dl-1', state: 'expired' }], sources, new Set(['dl-1']))
      ).toEqual([])
    })

    it('只有 expired 才触发：失败/取消/完成都不重试', () => {
      const jobs = [
        { id: 'dl-1', state: 'failed' },
        { id: 'dl-2', state: 'cancelled' },
        { id: 'dl-3', state: 'done' },
      ]
      expect(pickRelinkTargets(jobs, sources, new Set())).toEqual([])
    })

    it('多个任务同时过期时都要处理', () => {
      const jobs = [
        { id: 'dl-1', state: 'expired' },
        { id: 'dl-2', state: 'expired' },
      ]
      const many = { 'dl-1': {}, 'dl-2': {} }
      expect(pickRelinkTargets(jobs, many, new Set())).toEqual(['dl-1', 'dl-2'])
    })
  })

  /** 登录态体检：只报数量没用，要指出缺了哪个关键 Cookie */
  describe('cookieDiagnosis', () => {
    it('关键项齐全时通过', () => {
      const stored = ['quark.cn:__uid', 'quark.cn:__puus', 'quark.cn:__pus']
      expect(cookieDiagnosis(['__puus'], stored)).toEqual({ ok: true, missing: [] })
    })

    it('缺关键项时点名', () => {
      const stored = ['quark.cn:__uid']
      const diag = cookieDiagnosis(['__puus', '__uid'], stored)
      expect(diag.ok).toBe(false)
      expect(diag.missing).toEqual(['__puus'])
    })

    it('只粘了一半的百度 Cookie 会被抓出来', () => {
      const diag = cookieDiagnosis(['BDUSS', 'STOKEN'], ['baidu.com:BDUSS'])
      expect(diag.missing).toEqual(['STOKEN'])
    })

    it('没有关键项要求的网盘一律通过', () => {
      expect(cookieDiagnosis(undefined, [])).toEqual({ ok: true, missing: [] })
      expect(cookieDiagnosis([], ['x:y'])).toEqual({ ok: true, missing: [] })
    })

    it('名字匹配忽略域前缀', () => {
      // 不同子域下的同名 Cookie 都算数
      expect(cookieDiagnosis(['BDUSS'], ['pan.baidu.com:BDUSS']).ok).toBe(true)
    })
  })
})
