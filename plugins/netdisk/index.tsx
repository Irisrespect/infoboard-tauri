/**
 * 网盘下载插件
 *
 * 输入网盘分享链接 + 提取码 → 解析目录 → 多连接高速下载。
 *
 * ## 为什么每一行网络请求都要走 Rust
 *
 * 插件跑在应用的 WebView 里，`fetch` 受应用 CSP 约束（`connect-src` 只列了
 * 天气 / B 站等域名），而且网盘接口普遍需要自定义请求头、Cookie 和 POST，
 * 浏览器侧还必然撞 CORS。宿主为此提供了 `netdisk_http_request`（带 Cookie 罐的
 * HTTP 转发，域名锁定在网盘白名单内）与 `netdisk_download_start`（多连接分片下载）。
 *
 * ## 关于"免费高速"的真实情况（重要）
 *
 * 见 `ADAPTERS` 里每个适配器的 `speedNote`，以及设置面板底部的能力矩阵：
 * - **不限速**：蓝奏云（免登录）、任意未限速的直链 → 多连接能跑满带宽
 * - **限速但可用**：阿里云盘（免费 1–3MB/s）
 * - **基本没法免费高速**：百度网盘（账号级聚合限速 20–80KB/s，实测 4/8/16
 *   并发总量不变）、夸克网盘（非会员 200–700KB/s）
 *
 * 这是服务端按账号做的限速，不是"连接数不够"的问题，任何第三方客户端
 * （aria2 -x16、IDM、AList/OpenList）都突破不了，只有开会员才行。
 * 本插件不做、也不建议做伪 UA 之类的"破解"——那样既有封号风险，目前也已经失效。
 */

import type { InfoBoardPlugin } from '@/core/types'
import type { CSSProperties, Dispatch, SetStateAction } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

// ═══════════════════════════ 类型 ═══════════════════════════

interface HttpReq {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
  session?: string
  useCookies?: boolean
  allowHttp?: boolean
  timeoutMs?: number
  followRedirects?: boolean
}

interface HttpResp {
  status: number
  finalUrl: string
  headers: Record<string, string>
  body: string
  setCookies: string[]
}

interface FileEntry {
  id: string
  name: string
  size: number
  isDir: boolean
  updatedAt?: number
  /** 适配器私有数据（例如夸克的 share_fid_token） */
  extra?: Record<string, unknown>
}

interface ShareCtx {
  [key: string]: unknown
}

interface Resolved {
  url: string
  headers?: Record<string, string>
  fileName?: string
}

interface Adapter {
  id: string
  name: string
  icon: string
  /** Cookie 罐标识（与 Rust 侧 session 对应） */
  session: string
  /** 免费速度的真实情况，直接显示给用户 */
  speedNote: string
  /** 需要登录时给用户的提示 */
  loginHint?: string
  /** 是否允许明文 http（蓝奏云等） */
  allowHttp?: boolean
  /** 该适配器的 Cookie 应存到哪个域下 */
  cookieHost: string
  /**
   * 单文件并发上限。
   *
   * **不同网盘的限速策略完全不同，不能用同一个"线程数"滑块通吃：**
   * - 夸克/UC/天翼/移动/123/蓝奏：按**连接**限速 → 并发越多越快（收益巨大）
   * - 百度：按**账号**限速，且并发会**主动触发惩罚**。BaiduPCS-Go 作者原话是
   *   普通用户要把并发设为 1，"调大线程数只会在短时间内提升下载速度，且极易很快
   *   触发限速，导致几小时至几天内账号在各客户端都接近 0 速"
   *
   * 所以由适配器来定上限，而不是让用户一个滑块管所有网盘。
   */
  maxConnections?: number
  rootId: string
  match(url: string): boolean
  parse(url: string, pwd: string): Promise<{ ctx: ShareCtx; entries: FileEntry[]; title?: string }>
  list(ctx: ShareCtx, dirId: string): Promise<FileEntry[]>
  resolve(ctx: ShareCtx, file: FileEntry): Promise<Resolved>
}

interface JobStatus {
  id: string
  /** expired = 直链过期、挂起等换链（见 netdisk_download_relink） */
  state: 'running' | 'expired' | 'done' | 'failed' | 'cancelled'
  fileName: string
  path: string
  downloaded: number
  total: number
  speed: number
  connections: number
  error?: string | null
  elapsedMs: number
}

/**
 * 任务来源：直链过期后要靠它重新解析出新的直链。
 *
 * 必须能跨面板开关存活 —— 用户关掉面板再打开时任务还在后台跑，
 * 中途过期也得能自愈，所以落在 localStorage 里。
 */
interface JobSource {
  adapterId: string
  file: FileEntry
  relDir: string
  shareUrl: string
  pwd: string
}

interface Settings {
  destDir: string
  connections: number
}

// ═══════════════════════════ 常量 / 工具 ═══════════════════════════

const SETTINGS_KEY = 'netdisk:settings'
const HIDDEN_KEY = 'netdisk:hidden-jobs'
const SOURCES_KEY = 'netdisk:job-sources'

/** 任务来源表：任务 id → 怎么重新解析出直链（直链过期自愈要用） */
function loadJobSources(): Record<string, JobSource> {
  try {
    const raw = localStorage.getItem(SOURCES_KEY)
    const obj = raw ? (JSON.parse(raw) as unknown) : null
    return obj && typeof obj === 'object' ? (obj as Record<string, JobSource>) : {}
  } catch {
    return {}
  }
}

function saveJobSources(map: Record<string, JobSource>) {
  try {
    localStorage.setItem(SOURCES_KEY, JSON.stringify(map))
  } catch {
    /* 存储写满时忽略 */
  }
}

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const QUARK_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/3.14.2 Chrome/112.0.5615.165 Electron/24.1.3.8 Safari/537.36 Channel/pckk_other_ch'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

export function fmtSize(n: number): string {
  if (!n || n < 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

function fmtSpeed(n: number): string {
  return n > 0 ? `${fmtSize(n)}/s` : '—'
}

export function fmtEta(done: number, total: number, speed: number): string {
  if (!total || !speed || done >= total) return ''
  const left = Math.round((total - done) / speed)
  if (left < 60) return `${left} 秒`
  if (left < 3600) return `${Math.round(left / 60)} 分钟`
  return `${(left / 3600).toFixed(1)} 小时`
}

/** 文件名清洗（与 Rust 侧保持一致，避免落盘时被截断成另一个名字） */
export function safeName(name: string): string {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim() || 'unnamed'
}

/** 单个网盘账号的总连接预算。夸克是按账号限总连接数的，社区实测 512 为最优总量 */
export const CONNECTION_BUDGET = 512

/**
 * 把「账号总连接预算」按文件大小比例分给这一批任务。
 *
 * 为什么需要：如果一次排 5 个文件、每个都开 64 连接，就是 320 条连接同时在跑 ——
 * 既容易撞账号级总量上限，又让每个文件都变慢（配额被摊薄）。
 * 所以大文件多给、小文件保底。
 *
 * 规则参考 GeZi 的 ThreadAllocator：结果落在 [minPerFile, perFileCap]；
 * 大小未知时退回平分；**下限优先于预算**（宁可略微超预算，也不让小文件下不动）。
 */
export function allocateConnections(
  sizes: number[],
  perFileCap: number,
  budget = CONNECTION_BUDGET,
  minPerFile = 4
): number[] {
  const cap = Math.max(1, Math.floor(perFileCap))
  const floor = Math.min(Math.max(1, Math.floor(minPerFile)), cap)
  const n = sizes.length
  if (n === 0) return []
  if (n === 1) return [cap]

  const total = sizes.reduce((s, v) => s + (v > 0 ? v : 0), 0)
  if (total <= 0) {
    const even = Math.min(cap, Math.max(floor, Math.floor(budget / n)))
    return sizes.map(() => even)
  }

  const out = sizes.map((size) => {
    const share = size > 0 ? (budget * size) / total : 0
    return Math.min(cap, Math.max(floor, Math.round(share)))
  })

  // 四舍五入会让总和略微越界（512/3 → 171×3 = 513），从最大的项上扣回来；
  // 但不许把任何一项扣到下限以下
  let sum = out.reduce((s, v) => s + v, 0)
  let guard = 0
  while (sum > budget && guard++ < 100000) {
    let best = -1
    for (let i = 0; i < out.length; i++) {
      if (out[i] > floor && (best < 0 || out[i] > out[best])) best = i
    }
    if (best < 0) break
    out[best]--
    sum--
  }
  return out
}

function loadSettings(): Settings {
  const fallback: Settings = { destDir: '', connections: 16 }
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<Settings>
    return {
      destDir: typeof parsed.destDir === 'string' ? parsed.destDir : '',
      connections:
        typeof parsed.connections === 'number' && parsed.connections >= 1
          ? Math.min(64, parsed.connections)
          : 16,
    }
  } catch {
    return fallback
  }
}

function saveSettings(s: Settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s))
  } catch {
    /* 存储写满时忽略：设置丢一次不影响功能 */
  }
}

function loadHidden(): string[] {
  try {
    const raw = localStorage.getItem(HIDDEN_KEY)
    const arr = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(arr) ? (arr as string[]) : []
  } catch {
    return []
  }
}

// ═══════════════════════════ 传输层 ═══════════════════════════

async function http(req: HttpReq): Promise<HttpResp> {
  return invoke<HttpResp>('netdisk_http_request', { req })
}

/** 发请求并尽量解析 JSON（解析失败不抛，交给调用方判断） */
async function api<T = any>(req: HttpReq): Promise<{ status: number; json: T | null; raw: HttpResp }> {
  const raw = await http(req)
  let json: T | null = null
  try {
    json = JSON.parse(raw.body) as T
  } catch {
    json = null
  }
  return { status: raw.status, json, raw }
}

/** 把各网盘五花八门的错误码翻成一句人话 */
function explain(code: number | undefined, msg: string | undefined): string {
  const table: Record<number, string> = {
    '-6': '提取码错误',
    '-7': '提取码错误',
    '-9': '分享已失效或被删除',
    '-62': '触发风控，请稍后再试（或在浏览器里打开一次该链接）',
    '-8': '分享文件已被删除',
    0: '',
    112: '分享已过期',
    113: '分享已被取消',
    121: '该分享需要提取码',
    31066: '文件不存在或已被删除',
  }
  if (code !== undefined && table[code]) return table[code]
  if (msg) return msg
  return code !== undefined && code !== 0 ? `接口返回错误码 ${code}` : '接口返回异常'
}

// ═══════════════════════════ 适配器：夸克网盘 ═══════════════════════════

const QUARK_BASE = 'https://drive-pc.quark.cn'
const QUARK_HEADERS: Record<string, string> = {
  'User-Agent': QUARK_UA,
  Referer: 'https://pan.quark.cn/',
  Origin: 'https://pan.quark.cn',
}

function quarkPwdId(url: string): string {
  const m = url.match(/\/s\/([0-9a-zA-Z_-]+)/)
  return m ? m[1] : ''
}

function mapQuarkEntry(raw: any): FileEntry {
  return {
    id: String(raw.fid),
    name: String(raw.file_name || '未命名'),
    size: Number(raw.size || 0),
    isDir: raw.dir === true,
    updatedAt: Number(raw.updated_at || 0),
    extra: { shareFidToken: raw.share_fid_token },
  }
}

async function quarkDetail(ctx: ShareCtx, dirId: string): Promise<FileEntry[]> {
  const q = new URLSearchParams({
    pr: 'ucpro',
    fr: 'pc',
    uc_param_str: '',
    pwd_id: String(ctx.pwdId),
    stoken: String(ctx.stoken),
    pdir_fid: dirId,
    force: '0',
    _page: '1',
    _size: '200',
    _fetch_banner: '1',
    _fetch_share: '1',
    _fetch_total: '1',
    _sort: 'file_type:asc,updated_at:desc',
  })
  const { status, json } = await api<any>({
    url: `${QUARK_BASE}/1/clouddrive/share/sharepage/detail?${q.toString()}`,
    headers: QUARK_HEADERS,
    session: 'quark',
  })
  if (status === 401) throw new Error('夸克返回 401：登录态已失效，请在设置里重新粘贴 Cookie')
  if (!json) throw new Error(`夸克返回了非 JSON 内容（HTTP ${status}）`)
  if (json.code !== 0) {
    // 提取码错误时夸克不会在 token 接口报错，而是在这里暴露
    if (json.code === 41008 || json.code === 41009) throw new Error('提取码错误或未填写')
    throw new Error(`夸克列目录失败：${explain(json.code, json.message)}`)
  }
  return ((json.data && json.data.list) || []).map(mapQuarkEntry)
}

/**
 * 免转存取直链：`file/download` 直接吃分享的 `fids` + `fids_token` + `pwd_id` + `stoken`。
 *
 * - 匿名（未登录）也能用，但**只能取到约 50MB 以下**的文件：
 *   实测 38.6MB 成功、68.6MB 被 `code 23018 download file size limit` 拒绝。
 * - 登录后同一路径可直接取几百 MB ~ GB 级文件（实测 1278MB 正常）。
 * - 直链域名会体现档位：匿名是 `dl-guest-*`，登录后是 `dl-pc-*`。
 *
 * 返回空串表示这条路没走通，交给调用方回落到"转存"路线。
 */
async function quarkShareDownloadUrl(
  ctx: ShareCtx,
  fids: string[],
  tokens: string[]
): Promise<string> {
  const r = await api<any>({
    // 变体实测：pr=ucpro&fr=pc&uc_param_str= 可用；fr=android 会 401，不要用
    url: `${QUARK_BASE}/1/clouddrive/file/download?pr=ucpro&fr=pc&uc_param_str=`,
    method: 'POST',
    headers: { ...QUARK_HEADERS, 'Content-Type': 'application/json' },
    session: 'quark',
    body: JSON.stringify({
      fids,
      fids_token: tokens,
      pwd_id: String(ctx.pwdId),
      stoken: String(ctx.stoken),
    }),
  })
  if (r.status === 412) {
    throw new Error(
      '夸克直链请求被拒（412）：直链必须带上取链时那份会话 Cookie。请重新解析该分享后再下载。'
    )
  }
  const j = r.json
  if (!j) return ''
  if (j.code === 23018) {
    throw new Error(
      '夸克限制：未登录时只能取到约 50MB 以下文件的直链（实测 38.6MB 可下 / 68.6MB 被拒，错误码 23018）。\n' +
        '请在「设置 → 设置登录」粘贴夸克 Cookie 后再下 —— 登录后同一路径可直接下载几百 MB 到 GB 级文件。'
    )
  }
  if (j.code !== 0) return ''
  return (j.data && j.data[0] && j.data[0].download_url) || ''
}

const quarkAdapter: Adapter = {
  id: 'quark',
  name: '夸克网盘',
  icon: '⚡',
  session: 'quark',
  cookieHost: 'pan.quark.cn',
  rootId: '0',
  speedNote:
    '服务端按「连接」限速 —— 多开连接能叠加（建议 16–32 连接，默认 16）。单连接通常只有几百 KB/s；实际速度随账号/时段波动很大',
  maxConnections: 64,
  loginHint: '列目录免登录；转存与取下载直链必须登录夸克（粘贴 Cookie：__uid / __puus）',
  match: (url) => /(^|\.)quark\.cn$/i.test(hostOf(url)),
  parse: async (url, pwd) => {
    const pwdId = quarkPwdId(url)
    if (!pwdId) throw new Error('没能从链接里认出分享 ID，请检查链接格式（形如 https://pan.quark.cn/s/xxxx）')
    const { status, json } = await api<any>({
      url: `${QUARK_BASE}/1/clouddrive/share/sharepage/token?pr=ucpro&fr=pc&uc_param_str=`,
      method: 'POST',
      headers: { ...QUARK_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ pwd_id: pwdId, passcode: pwd || '' }),
      session: 'quark',
    })
    if (!json) throw new Error(`夸克返回了非 JSON 内容（HTTP ${status}）`)
    if (status === 404 || json.code === 41006) throw new Error('分享不存在或已被删除（请检查链接）')
    if (json.code !== 0) throw new Error(`夸克解析失败：${explain(json.code, json.message)}`)
    const ctx: ShareCtx = { pwdId, stoken: json.data && json.data.stoken }
    const entries = await quarkDetail(ctx, '0')
    return { ctx, entries, title: (json.data && json.data.title) || '' }
  },
  list: (ctx, dirId) => quarkDetail(ctx, dirId),
  resolve: async (ctx, file) => {
    // 路线 B（默认）：**免转存** —— 直接把分享的 fid + share_fid_token 换成直链。
    // 不往用户网盘里写任何东西：不占空间（网盘满了也能下）、不用清理、
    // 少两次远端状态变更（save + delete），风控面更小。2026-10 实测已跑通。
    const token = (file.extra && (file.extra.shareFidToken as string)) || ''
    const direct = await quarkShareDownloadUrl(ctx, [file.id], [token])
    if (direct) {
      return {
        url: direct,
        headers: { 'User-Agent': QUARK_UA, Referer: 'https://pan.quark.cn/' },
        fileName: file.name,
      }
    }

    // 路线 A（兜底）：免转存没走通时才转存到自己网盘，再取直链
    const save = await api<any>({
      url: `${QUARK_BASE}/1/clouddrive/share/sharepage/save?pr=ucpro&fr=pc&uc_param_str=`,
      method: 'POST',
      headers: { ...QUARK_HEADERS, 'Content-Type': 'application/json' },
      session: 'quark',
      body: JSON.stringify({
        fid_list: [file.id],
        fid_token_list: [(file.extra && file.extra.shareFidToken) || ''],
        to_pdir_fid: '0',
        pwd_id: String(ctx.pwdId),
        stoken: String(ctx.stoken),
        pdir_fid: '0',
        scene: 'link',
        operation: 'save',
      }),
    })
    if (save.status === 401 || (save.json && save.json.code === 401)) {
      throw new Error('夸克需要登录才能转存：请在「设置 → 账号」粘贴夸克 Cookie（至少含 __uid、__puus）')
    }
    if (!save.json || save.json.code !== 0) {
      throw new Error(`夸克转存失败：${explain(save.json && save.json.code, save.json && save.json.message)}`)
    }
    const taskId = save.json.data && save.json.data.task_id

    // 轮询转存任务（夸克是异步的，通常几百毫秒完成）
    let newFid = ''
    for (let i = 0; i < 40; i++) {
      await sleep(500)
      const t = await api<any>({
        url: `${QUARK_BASE}/1/clouddrive/task?pr=ucpro&fr=pc&uc_param_str=&task_id=${encodeURIComponent(
          String(taskId)
        )}&retry_index=0`,
        headers: QUARK_HEADERS,
        session: 'quark',
      })
      const st = t.json && t.json.data && t.json.data.status
      if (st === 2) {
        newFid = (t.json.data.save_as && t.json.data.save_as.save_as_top_fids && t.json.data.save_as.save_as_top_fids[0]) || ''
        break
      }
      if (st === 3) throw new Error('夸克转存任务失败（可能是网盘空间已满，或转存过于频繁触发风控）')
    }
    if (!newFid) throw new Error('夸克转存超时，请稍后重试')

    const dl = await api<any>({
      url: `${QUARK_BASE}/1/clouddrive/file/download?pr=ucpro&fr=pc&sys=win32&ve=2.5.56`,
      method: 'POST',
      headers: { ...QUARK_HEADERS, 'Content-Type': 'application/json' },
      session: 'quark',
      body: JSON.stringify({ fids: [newFid] }),
    })
    if (dl.status === 401 || (dl.json && dl.json.code === 401)) {
      throw new Error('夸克取直链被拒绝（401）：登录态失效，请重新粘贴 Cookie')
    }
    const url2 = dl.json && dl.json.data && dl.json.data[0] && dl.json.data[0].download_url
    if (!url2) throw new Error(`夸克没返回下载直链：${explain(dl.json && dl.json.code, dl.json && dl.json.message)}`)
    return {
      url: String(url2),
      headers: { 'User-Agent': QUARK_UA, Referer: 'https://pan.quark.cn/' },
      fileName: file.name,
    }
  },
}

// ═══════════════════════════ 适配器：蓝奏云 ═══════════════════════════

/**
 * 蓝奏云（以及它的十几个轮换域名）免费、免登录、不限速 —— 是"免费高速"里
 * 唯一真正成立的一家。代价是站点有 `acw_sc__v2` WAF 挑战 + 页面结构多变，
 * 属于"需要跟着站点改"的适配器。
 */
const LANZOU_HOST_RE = /(^|\.)(lanzou[a-z]?\.(com|cn)|lanzn\.com|lanzt\.com|ilanzou\.com)$/i

/**
 * 解 acw_sc__v2 挑战：把 arg1 按固定表重排，再与固定 key 逐字节异或。
 * 这是社区公开的算法，站点改算法前一直有效。
 */
export function acwScV2(arg1: string): string {
  const PERM = [
    0xf, 0x23, 0x1d, 0x18, 0x21, 0x10, 0x1, 0x26, 0xa, 0x9, 0x13, 0x1f, 0x28, 0x1b, 0x16, 0x17,
    0x19, 0xd, 0x6, 0xb, 0x27, 0x12, 0x14, 0x8, 0xe, 0x15, 0x20, 0x1a, 0x2, 0x1e, 0x7, 0x4, 0x11,
    0x5, 0x3, 0x1c, 0x22, 0x25, 0xc, 0x24,
  ]
  const KEY = '3000176000856006061501533003690027800375'
  const boxed: string[] = new Array(40).fill('')
  for (let i = 0; i < 40 && i < arg1.length; i++) boxed[PERM[i] - 1] = arg1.charAt(i)
  const permuted = boxed.join('')
  let out = ''
  for (let i = 0; i + 2 <= permuted.length && i + 2 <= KEY.length; i += 2) {
    const x = parseInt(permuted.substr(i, 2), 16) ^ parseInt(KEY.substr(i, 2), 16)
    out += ('0' + x.toString(16)).slice(-2)
  }
  return out
}

/** 带 WAF 挑战自动重试的 GET */
async function lanzouGet(url: string, referer?: string): Promise<HttpResp> {
  const doGet = () =>
    http({
      url,
      session: 'lanzou',
      allowHttp: true,
      headers: { 'User-Agent': BROWSER_UA, Referer: referer || url },
    })
  let r = await doGet()
  const m = r.body.match(/var\s+arg1\s*=\s*'([0-9a-fA-F]+)'/)
  if (m) {
    const val = acwScV2(m[1])
    await invoke('netdisk_cookie_import', {
      session: 'lanzou',
      host: hostOf(url),
      raw: `acw_sc__v2=${val}`,
    })
    r = await doGet()
  }
  return r
}

const lanzouAdapter: Adapter = {
  id: 'lanzou',
  name: '蓝奏云',
  icon: '🔵',
  session: 'lanzou',
  cookieHost: 'lanzoui.com',
  rootId: 'root',
  allowHttp: true,
  speedNote: '免登录、官方不限速 —— 多连接可以跑满你的带宽（真正的免费高速）',
  maxConnections: 32,
  match: (url) => LANZOU_HOST_RE.test(hostOf(url)),
  parse: async (url, pwd) => {
    const origin = `${new URL(url).protocol}//${hostOf(url)}`
    let page = await lanzouGet(url)

    // 需要提取码时，页面是个表单，POST 同一地址即可
    if (pwd && /name=["']pwd["']/.test(page.body)) {
      page = await http({
        url,
        method: 'POST',
        session: 'lanzou',
        allowHttp: true,
        headers: {
          'User-Agent': BROWSER_UA,
          'Content-Type': 'application/x-www-form-urlencoded',
          Referer: url,
        },
        body: `pwd=${encodeURIComponent(pwd)}`,
      })
    }
    if (/提取码|密码错误|密码不正确/.test(page.body) && /name=["']pwd["']/.test(page.body)) {
      throw new Error('蓝奏云提取码错误（或未填写）')
    }

    // 情形一：页面里就直接有下载按钮
    const direct = page.body.match(/href="(https?:\/\/[^"]+\/file\/[^"]+)"/)
    if (direct) {
      return {
        ctx: { origin, pageUrl: url, directUrl: direct[1] },
        entries: [{ id: 'file', name: guessLanzouName(page.body), size: guessLanzouSize(page.body), isDir: false }],
      }
    }

    // 情形二：页面里嵌 iframe，直链要通过 ajaxm.php 换
    const ifr = page.body.match(/<iframe[^>]+src="([^"]+)"/)
    if (!ifr) {
      throw new Error(
        '没能从蓝奏云页面里找到下载入口（页面结构可能已变化，或该链接是文件夹分享）。可把页面上的直链直接粘到「直链下载」里。'
      )
    }
    const iframeUrl = ifr[1].startsWith('http') ? ifr[1] : origin + ifr[1]
    const js = await lanzouGet(iframeUrl, url)
    const ajaxm = js.body.match(/url\s*=\s*['"]([^'"]*ajaxm\.php[^'"]*)['"]/)
    const sign = js.body.match(/['"]sign['"]\s*[:=]\s*['"]([^'"]+)['"]/)
    const p = js.body.match(/['"]p['"]\s*[:=]\s*['"]([^'"]+)['"]/)
    if (!ajaxm || !sign || !p) {
      throw new Error('蓝奏云直链接口结构已变化，暂时无法自动解析（可在浏览器打开后复制直链，用「直链下载」下载）')
    }
    return {
      ctx: {
        origin,
        pageUrl: url,
        ajaxm: ajaxm[1].startsWith('http') ? ajaxm[1] : origin + ajaxm[1],
        sign: sign[1],
        p: p[1],
      },
      entries: [{ id: 'file', name: guessLanzouName(page.body), size: guessLanzouSize(page.body), isDir: false }],
    }
  },
  list: async () => {
    throw new Error('蓝奏云的文件夹分享暂不支持（社区接口不稳定），请改用单文件分享链接')
  },
  resolve: async (ctx, file) => {
    if (ctx.directUrl) {
      return { url: String(ctx.directUrl), headers: { Referer: String(ctx.pageUrl), 'User-Agent': BROWSER_UA } }
    }
    const res = await http({
      url: String(ctx.ajaxm),
      method: 'POST',
      session: 'lanzou',
      allowHttp: true,
      headers: {
        'User-Agent': BROWSER_UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
        Referer: String(ctx.pageUrl),
      },
      body: `action=downprocess&websign=&websignkey=&sign=${encodeURIComponent(
        String(ctx.sign)
      )}&p=${encodeURIComponent(String(ctx.p))}&kd=1`,
    })
    let j: any = null
    try {
      j = JSON.parse(res.body)
    } catch {
      throw new Error('蓝奏云返回了非 JSON 内容（接口可能已变化）')
    }
    if (!j || j.zt !== 1) throw new Error(`蓝奏云取直链失败：${(j && j.inf) || '接口返回异常'}`)
    const finalUrl = `${j.dom}/file/${j.url}`
    return {
      url: finalUrl,
      headers: { Referer: String(ctx.pageUrl), 'User-Agent': BROWSER_UA },
      fileName: file.name,
    }
  },
}

function guessLanzouName(html: string): string {
  const m =
    html.match(/<title>([^<]*)<\/title>/) ||
    html.match(/class="filethetext"[^>]*>([^<]*)</) ||
    html.match(/<div class="n_fileerg">([^<]*)</)
  if (!m) return '蓝奏云文件'
  return (
    m[1]
      .replace(/[-_|]\s*蓝奏云.*$/, '')
      .replace(/^\s*$/, '蓝奏云文件')
      .trim() || '蓝奏云文件'
  )
}

function guessLanzouSize(html: string): number {
  const m = html.match(/大小[:：]\s*([\d.]+)\s*(B|KB|MB|GB)/i)
  if (!m) return 0
  const mult: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }
  return Math.round(parseFloat(m[1]) * (mult[m[2].toUpperCase()] || 1))
}

// ═══════════════════════════ 适配器：百度网盘 ═══════════════════════════

const BAIDU_TRANSFER_DIR = '/InfoBoard中转'

const baiduAdapter: Adapter = {
  id: 'baidu',
  name: '百度网盘',
  icon: '🐾',
  session: 'baidu',
  cookieHost: 'pan.baidu.com',
  rootId: '/',
  speedNote:
    '非会员是账号级限速（实测 20–80KB/s，4/8/16 并发总量不变）—— 任何第三方工具都突破不了，只有 SVIP 能提速',
  // 百度是"并发越多越糟"的典型：调大线程会主动触发限速惩罚，
  // 而且惩罚是账号级的、可能持续几小时到几天。所以这里硬性锁 1 路。
  maxConnections: 1,
  loginHint: '必须登录：在浏览器打开 pan.baidu.com，复制 Cookie 里的 BDUSS 与 STOKEN',
  match: (url) => /(^|\.)baidu\.com$/i.test(hostOf(url)) && /\/s\/|\/share\//.test(url),
  parse: async (url, pwd) => {
    const surl = baiduSurl(url)
    if (!surl) throw new Error('没能从链接里认出分享 ID（形如 https://pan.baidu.com/s/1xxxx）')

    const verify = await http({
      url: `https://pan.baidu.com/share/verify?surl=${surl}&t=${Date.now()}&channel=chunlei&web=1&clienttype=0`,
      method: 'POST',
      session: 'baidu',
      headers: {
        'User-Agent': BROWSER_UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: `https://pan.baidu.com/s/1${surl}`,
      },
      body: `pwd=${encodeURIComponent(pwd)}&vcode=&vcode_str=`,
    })
    let vj: any = null
    try {
      vj = JSON.parse(verify.body)
    } catch {
      throw new Error('百度网盘校验接口返回异常（可能需要先在浏览器里打开一次该分享链接过验证码）')
    }
    if (vj.errno !== 0) throw new Error(`百度网盘校验失败：${explain(vj.errno, vj.err_msg)}`)

    // 分享页内嵌 locals.mset({...}) 里有 shareid / share_uk / file_list
    const page = await http({
      url: `https://pan.baidu.com/s/1${surl}?pwd=${encodeURIComponent(pwd)}`,
      session: 'baidu',
      headers: { 'User-Agent': BROWSER_UA, Referer: 'https://pan.baidu.com/disk/home' },
    })
    const m = page.body.match(/locals\.mset\((\{[\s\S]*?\})\);/)
    if (!m) {
      throw new Error('没能解析百度网盘分享页（未登录时页面会跳转到登录页，请先粘贴 BDUSS Cookie）')
    }
    let data: any = null
    try {
      data = JSON.parse(m[1])
    } catch {
      throw new Error('百度网盘分享页数据结构已变化，无法解析')
    }
    const ctx: ShareCtx = {
      surl,
      shareid: data.shareid,
      uk: data.share_uk,
      rootPath: (data.file_list && data.file_list[0] && String(data.file_list[0].path).replace(/\/[^/]*$/, '')) || '/',
    }
    const entries = (data.file_list || []).map(mapBaiduEntry)
    return { ctx, entries, title: '' }
  },
  list: async () => {
    throw new Error(
      '百度网盘的子目录浏览需要额外的分页接口，当前版本只支持分享根目录下的文件（可勾选后下载）'
    )
  },
  resolve: async (ctx, file) => {
    // 转存到自己网盘 → 列目录拿路径 → 走 PCS 下载接口（web 端 dlink 已大面积 sign error）
    const transfer = await http({
      url: `https://pan.baidu.com/share/transfer?shareid=${ctx.shareid}&from=${ctx.uk}&bdstoken=&ondup=newcopy&async=2&channel=chunlei&web=1&app_id=250528`,
      method: 'POST',
      session: 'baidu',
      headers: {
        'User-Agent': BROWSER_UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: `https://pan.baidu.com/s/1${ctx.surl}`,
      },
      body: `fsidlist=[${file.id}]&path=${encodeURIComponent(BAIDU_TRANSFER_DIR)}`,
    })
    let tj: any = null
    try {
      tj = JSON.parse(transfer.body)
    } catch {
      throw new Error('百度网盘转存接口返回异常（登录态可能已失效，请重新粘贴 BDUSS）')
    }
    if (tj.errno !== 0) {
      throw new Error(
        `百度网盘转存失败：${explain(tj.errno, tj.err_msg)}（非会员也可能因为"中转目录"不存在而失败，请先在网盘里建一个同名目录）`
      )
    }
    const remotePath = `${BAIDU_TRANSFER_DIR}/${file.name}`
    const dlUrl = `https://d.pcs.baidu.com/rest/2.0/pcs/file?method=download&app_id=250528&path=${encodeURIComponent(
      remotePath
    )}`
    return {
      url: dlUrl,
      // 大文件不带这个 UA 会被防盗链拦掉；注意它只是"能下"，不是"加速"
      headers: { 'User-Agent': 'pan.baidu.com', Referer: 'https://pan.baidu.com/disk/home' },
      fileName: file.name,
    }
  },
}

function baiduSurl(url: string): string {
  const m = url.match(/\/s\/1([0-9a-zA-Z_-]+)/) || url.match(/surl=([0-9a-zA-Z_-]+)/)
  return m ? m[1] : ''
}

function mapBaiduEntry(raw: any): FileEntry {
  return {
    id: String(raw.fs_id),
    name: String(raw.server_filename || '未命名'),
    size: Number(raw.size || 0),
    isDir: Number(raw.isdir) === 1,
    updatedAt: Number(raw.server_mtime || 0) * 1000,
    extra: { path: raw.path },
  }
}

// ═══════════════════════════ 适配器：任意直链 ═══════════════════════════

const directAdapter: Adapter = {
  id: 'direct',
  name: '直链下载',
  icon: '🔗',
  session: 'direct',
  cookieHost: 'localhost',
  rootId: 'root',
  allowHttp: true,
  speedNote: '只要服务端不限速，多连接就能跑满带宽（这也是最通用的兜底方式）',
  match: (url) => /^https?:\/\//i.test(url.trim()),
  parse: async (url) => {
    const clean = url.trim()
    let name = 'download.bin'
    try {
      const seg = decodeURIComponent(new URL(clean).pathname.split('/').filter(Boolean).pop() || '')
      if (seg && /\.[a-z0-9]{1,8}$/i.test(seg)) name = seg
    } catch {
      /* 用默认名 */
    }
    return {
      ctx: { url: clean },
      entries: [{ id: clean, name: safeName(name), size: 0, isDir: false, extra: { isDirect: true } }],
    }
  },
  list: async () => [],
  resolve: async (_ctx, file) => ({ url: file.id }),
}

// ═══════════════════════════ 适配器注册表 ═══════════════════════════

/** 顺序即优先级：先匹配到的适配器胜出 */
const ADAPTERS: Adapter[] = [quarkAdapter, lanzouAdapter, baiduAdapter, directAdapter]

/**
 * 认得出、但还没接入的网盘。
 *
 * 不这样拦一道的话，阿里云盘/123 云盘的分享链接会落到最后的「直链下载」兜底上，
 * 然后去"下载"一个 HTML 分享页 —— 用户看到的是一个莫名其妙的 bin 文件，
 * 而不是"这个网盘还没支持，原因是……"。
 */
const UNSUPPORTED: { re: RegExp; name: string; why: string }[] = [
  {
    re: /(^|\.)(alipan|aliyundrive)\.com$/i,
    name: '阿里云盘',
    why: '还没有接入（需要 refresh_token 登录链路）。它免费有 1–3MB/s，是下一步最值得做的',
  },
  {
    re: /(^|\.)(123pan|123684|123865|123912)\.(com|cn)$/i,
    name: '123 云盘',
    why: '2025-11 起取消游客下载，免费账号每月 10GB 额度',
  },
  { re: /(^|\.)uc\.cn$/i, name: 'UC 网盘', why: '与夸克同源，等夸克适配器稳定后再复用同一套接口' },
  { re: /(^|\.)189\.cn$/i, name: '天翼云盘', why: 'Cookie 必须与账号 IP 一致，桌面端很容易失败' },
  { re: /(^|\.)(115|anxia)\.com$/i, name: '115 网盘', why: '开放平台 2026-08 已暂停服务，只剩逆向接口' },
  { re: /(^|\.)(139|mcloud|cmcccloud)\.com$/i, name: '中国移动云盘', why: '分享接口的请求体是加密的，尚未接入' },
  { re: /(^|\.)xunlei\.(com|cn)$/i, name: '迅雷云盘', why: '必须登录转存，且新注册非会员已无高速下载流量' },
  { re: /(^|\.)(ctfile|545c)\.(com|net)$/i, name: '城通网盘', why: '官方硬限速 100KB/s，解析也提不了速' },
]

export function findUnsupported(url: string): { name: string; why: string } | null {
  const host = hostOf(url)
  if (!host) return null
  for (const u of UNSUPPORTED) {
    if (u.re.test(host)) return u
  }
  return null
}

export function detectAdapter(url: string): Adapter | null {
  const u = url.trim()
  if (!u) return null
  // 直链适配器放在最后：它是万能兜底，不该抢走网盘链接
  for (const a of ADAPTERS) {
    if (a.id === 'direct') continue
    if (a.match(u)) return a
  }
  return /^https?:\/\//i.test(u) ? directAdapter : null
}

function adapterById(id: string): Adapter | null {
  return ADAPTERS.find((a) => a.id === id) || null
}

// ═══════════════════════════ 组件 ═══════════════════════════

const panelStyle: CSSProperties = { padding: '12px', fontSize: 12, color: 'var(--text-primary)' }
const inputStyle: CSSProperties = {
  width: '100%',
  padding: '6px 8px',
  fontSize: 12,
  borderRadius: 6,
  border: '1px solid var(--border-subtle)',
  background: 'var(--bg-surface)',
  color: 'var(--text-primary)',
  outline: 'none',
}
const btn = (primary?: boolean): CSSProperties => ({
  padding: '5px 10px',
  fontSize: 12,
  borderRadius: 6,
  cursor: 'pointer',
  border: '1px solid var(--border-subtle)',
  background: primary ? 'var(--accent)' : 'var(--bg-surface)',
  color: primary ? '#fff' : 'var(--text-primary)',
})
const muted: CSSProperties = { color: 'var(--text-muted)', fontSize: 11 }

function NetdiskPanel() {
  const [url, setUrl] = useState('')
  const [pwd, setPwd] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [adapter, setAdapter] = useState<Adapter | null>(null)
  const [ctx, setCtx] = useState<ShareCtx | null>(null)
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [stack, setStack] = useState<{ id: string; name: string }[]>([])
  const [selected, setSelected] = useState<Record<string, boolean>>({})
  const [title, setTitle] = useState('')

  const [jobs, setJobs] = useState<JobStatus[]>([])
  const [hidden, setHidden] = useState<string[]>(() => loadHidden())
  const [settings, setSettings] = useState<Settings>(() => loadSettings())
  const [showSettings, setShowSettings] = useState(false)
  const [cookieDraft, setCookieDraft] = useState<Record<string, string>>({})
  const [cookieSaved, setCookieSaved] = useState<Record<string, string[]>>({})

  const detected = detectAdapter(url)
  const lastJobsKey = useRef('')
  /** 任务来源表（跨面板开关存活）*/
  const jobSourcesRef = useRef<Record<string, JobSource>>(loadJobSources())
  /** 当前分享上下文：轮询回调里要用到最新值，但不能进轮询的依赖 */
  const ctxRef = useRef<ShareCtx | null>(null)
  /** 正在换链的任务，避免每 800ms 重复发起 */
  const relinkingRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    ctxRef.current = ctx
  }, [ctx])

  // ── 默认下载目录（首次打开时问一次后端）
  useEffect(() => {
    if (settings.destDir) return
    invoke<string>('netdisk_default_download_dir')
      .then((dir) => {
        setSettings((s) => {
          const next = { ...s, destDir: dir }
          saveSettings(next)
          return next
        })
      })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * 直链过期自愈：重新解析分享 → 把新直链交给后端续传。
   *
   * 网盘直链只有 5~10 分钟有效期，大文件必然中途过期。后端的做法是：
   * 撞上 401/403/412 就把未完成的分片放回队列、状态置为 `expired` 并等在这里；
   * 我们重新解析一次拿到新直链，`netdisk_download_relink` 一调用，
   * 它就从未完成的分片继续下 —— 已下完的部分不会重下。
   */
  const relinkOne = useCallback(async (jobId: string, src: JobSource) => {
    const ad = adapterById(src.adapterId)
    if (!ad) return
    let shareCtx = ctxRef.current
    try {
      if (!shareCtx) throw new Error('分享上下文已丢失，需要重新解析')
      let resolved: Resolved
      try {
        resolved = await ad.resolve(shareCtx, src.file)
      } catch (e) {
        // stoken 自己也会过期（实测 ≥10 分钟），先重新解析一次再试
        console.warn('[网盘下载] 直接换链失败，重新解析分享后重试:', e)
        const fresh = await ad.parse(src.shareUrl, src.pwd)
        shareCtx = fresh.ctx
        ctxRef.current = fresh.ctx
        setCtx(fresh.ctx)
        resolved = await ad.resolve(fresh.ctx, src.file)
      }
      await invoke('netdisk_download_relink', {
        id: jobId,
        url: resolved.url,
        headers: resolved.headers,
        allowHttp: !!ad.allowHttp,
      })
      setNotice('直链已过期，已自动换链并从断点继续')
    } catch (e) {
      setError(
        `自动换链失败：${e instanceof Error ? e.message : String(e)}\n` +
          '（后端会在等待超时后结束该任务，可重新解析后再下）'
      )
    }
  }, [])

  // ── 轮询下载进度：插件 import 不到 event 模块，只能轮询
  useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        const list = await invoke<JobStatus[]>('netdisk_download_list')
        if (!alive) return
        // 内容没变就不 setState，避免每 800ms 白重渲染一次
        const key = JSON.stringify(list)
        if (key !== lastJobsKey.current) {
          lastJobsKey.current = key
          setJobs(list)
        }
        // 有任务在等新直链 → 立刻去换（这就是"自愈"的触发点）
        for (const job of list) {
          if (job.state !== 'expired') continue
          if (relinkingRef.current.has(job.id)) continue
          const src = jobSourcesRef.current[job.id]
          if (!src) continue
          relinkingRef.current.add(job.id)
          void relinkOne(job.id, src).finally(() => relinkingRef.current.delete(job.id))
        }
      } catch {
        /* 后端未就绪时忽略 */
      }
    }
    void tick()
    const timer = setInterval(tick, 800)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [relinkOne])

  const applySettings = useCallback((next: Settings) => {
    setSettings(next)
    saveSettings(next)
  }, [])

  const persistHidden = useCallback((ids: string[]) => {
    setHidden(ids)
    try {
      localStorage.setItem(HIDDEN_KEY, JSON.stringify(ids))
    } catch {
      /* 忽略 */
    }
  }, [])

  // ── 解析
  const parse = useCallback(async () => {
    const raw = url.trim()
    const known = findUnsupported(raw)
    if (known) {
      setAdapter(null)
      setCtx(null)
      setEntries([])
      setError(
        `暂不支持 ${known.name}：${known.why}。\n如果它给你的是直链，可以直接粘到「直链下载」里下。`
      )
      return
    }
    const target = detected
    if (!target) {
      setError('没认出这是哪家网盘。支持夸克网盘 / 蓝奏云 / 百度网盘分享链接，或直接粘贴任意 http(s) 直链。')
      return
    }
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const r = await target.parse(url.trim(), pwd.trim())
      setAdapter(target)
      setCtx(r.ctx)
      setEntries(r.entries)
      setStack([])
      setSelected({})
      setTitle(r.title || '')
      if (r.entries.length === 0) setNotice('解析成功，但这个分享里没有文件')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setAdapter(null)
      setCtx(null)
      setEntries([])
    } finally {
      setBusy(false)
    }
  }, [detected, url, pwd])

  // ── 进入子目录
  const enterDir = useCallback(
    async (entry: FileEntry) => {
      if (!adapter || !ctx) return
      setBusy(true)
      setError(null)
      try {
        const kids = await adapter.list(ctx, entry.id)
        setStack((s) => [...s, { id: entry.id, name: entry.name }])
        setEntries(kids)
        setSelected({})
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
      }
    },
    [adapter, ctx]
  )

  const goBack = useCallback(
    async (index: number) => {
      if (!adapter || !ctx) return
      setBusy(true)
      setError(null)
      try {
        const target = index < 0 ? adapter.rootId : stack[index].id
        const kids = await adapter.list(ctx, target)
        setStack((s) => (index < 0 ? [] : s.slice(0, index + 1)))
        setEntries(kids)
        setSelected({})
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
      }
    },
    [adapter, ctx, stack]
  )

  // ── 下载（含目录递归）
  const download = useCallback(
    async (targets: FileEntry[]) => {
      if (!adapter || !ctx) return
      setBusy(true)
      setError(null)
      let started = 0
      const failures: string[] = []
      try {
        const flat: { entry: FileEntry; relDir: string }[] = []
        for (const t of targets) {
          await collectFiles(adapter, ctx, t, '', flat, 0)
        }
        if (flat.length === 0) {
          setError('没有可下载的文件')
          return
        }
        // 按"账号总连接预算"给这一批文件分连接数：大文件多给、小文件保底。
        // 上限还要再看适配器：百度必须锁 1 路（并发会触发账号级限速惩罚）
        const cap = Math.min(settings.connections, adapter.maxConnections ?? 64)
        const perFile = allocateConnections(
          flat.map((f) => f.entry.size || 0),
          cap
        )
        for (let i = 0; i < flat.length; i++) {
          const item = flat[i]
          try {
            const resolved = await adapter.resolve(ctx, item.entry)
            const destDir = item.relDir
              ? `${settings.destDir}/${item.relDir.replace(/\//g, '\\')}`
              : settings.destDir
            const started2 = await invoke<JobStatus>('netdisk_download_start', {
              req: {
                url: resolved.url,
                fileName: resolved.fileName || item.entry.name,
                destDir: destDir || undefined,
                headers: resolved.headers,
                session: adapter.session,
                // 直链的域常和登录域不同（CDN），显式告诉后端去哪拿 Cookie
                cookieHost: adapter.cookieHost,
                connections: perFile[i] || cap,
                allowHttp: !!adapter.allowHttp,
                overwrite: false,
              },
            })
            // 记下"这个任务是怎么来的"：直链过期时要靠它重新解析
            jobSourcesRef.current[started2.id] = {
              adapterId: adapter.id,
              file: item.entry,
              relDir: item.relDir,
              shareUrl: url.trim(),
              pwd: pwd.trim(),
            }
            saveJobSources(jobSourcesRef.current)
            started++
          } catch (e) {
            failures.push(`${item.entry.name}: ${e instanceof Error ? e.message : String(e)}`)
          }
        }
        if (failures.length) {
          setError(`部分文件没能开始下载：\n${failures.slice(0, 3).join('\n')}`)
        } else if (flat.length > 1) {
          setNotice(`已开始下载 ${started} 个文件（按文件大小分配连接：${perFile.join(' / ')}）`)
        } else {
          setNotice(`已开始下载 ${started} 个文件`)
        }
        // 立刻刷新一次任务列表
        const list = await invoke<JobStatus[]>('netdisk_download_list')
        lastJobsKey.current = JSON.stringify(list)
        setJobs(list)
      } finally {
        setBusy(false)
      }
    },
    [adapter, ctx, settings]
  )

  const selectedEntries = entries.filter((e) => selected[e.id])

  const visibleJobs = jobs.filter((j) => !hidden.includes(j.id))
  const runningCount = jobs.filter((j) => j.state === 'running').length

  const saveCookie = useCallback(async (a: Adapter) => {
    const raw = (cookieDraft[a.id] || '').trim()
    if (!raw) return
    try {
      const n = await invoke<number>('netdisk_cookie_import', {
        session: a.session,
        host: a.cookieHost,
        raw,
      })
      setNotice(`已保存 ${a.name} 的 ${n} 个 Cookie 字段`)
      setCookieDraft((d) => ({ ...d, [a.id]: '' }))
      const names = await invoke<string[]>('netdisk_cookie_list', { session: a.session })
      setCookieSaved((s) => ({ ...s, [a.id]: names }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [cookieDraft])

  const pickDir = useCallback(async () => {
    try {
      // 走宿主已开放的 dialog:allow-open 能力（插件不能 import plugin-dialog）
      const picked = await invoke<string | string[] | null>('plugin:dialog|open', {
        options: { directory: true, multiple: false, title: '选择下载保存目录' },
      })
      const dir = Array.isArray(picked) ? picked[0] : picked
      if (dir) applySettings({ ...settings, destDir: dir })
    } catch (e) {
      setError(`选择目录失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }, [applySettings, settings])

  // ═══ 渲染 ═══

  return (
    <div style={panelStyle}>
      {/* 输入区 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            style={{ ...inputStyle, flex: 1 }}
            placeholder="粘贴网盘分享链接（如 https://pan.quark.cn/s/xxxx）"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void parse()
            }}
          />
          <input
            style={{ ...inputStyle, width: 90 }}
            placeholder="提取码"
            value={pwd}
            onChange={(e) => setPwd(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void parse()
            }}
          />
          <button style={btn(true)} disabled={busy} onClick={() => void parse()}>
            {busy ? '处理中…' : '解析'}
          </button>
        </div>

        {/* 识别结果 + 限速说明 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {detected ? (
            <span style={{ ...muted, color: 'var(--accent)' }}>
              {detected.icon} 识别为 {detected.name}
            </span>
          ) : (
            <span style={muted}>支持：夸克网盘 · 蓝奏云 · 百度网盘 · 任意直链</span>
          )}
          {detected && detected.id !== 'direct' && (
            <span style={muted} title={detected.speedNote}>
              ⓘ {detected.speedNote}
            </span>
          )}
          <button
            style={{ ...btn(), marginLeft: 'auto', padding: '3px 8px' }}
            onClick={() => setShowSettings((v) => !v)}
          >
            {showSettings ? '收起设置' : '设置'}
          </button>
        </div>
      </div>

      {error && (
        <div
          style={{
            marginTop: 8,
            padding: '8px 10px',
            borderRadius: 6,
            background: 'rgba(220,60,60,0.10)',
            border: '1px solid rgba(220,60,60,0.35)',
            color: '#d9534f',
            whiteSpace: 'pre-wrap',
            lineHeight: 1.6,
          }}
        >
          {error}
        </div>
      )}
      {notice && !error && (
        <div style={{ ...muted, marginTop: 8, color: 'var(--accent)' }}>{notice}</div>
      )}

      {/* 设置 */}
      {showSettings && (
        <SettingsPanel
          settings={settings}
          onChange={applySettings}
          onPickDir={pickDir}
          cookieDraft={cookieDraft}
          setCookieDraft={setCookieDraft}
          cookieSaved={cookieSaved}
          setCookieSaved={setCookieSaved}
          onSaveCookie={saveCookie}
          onError={setError}
          onNotice={setNotice}
        />
      )}

      {/* 文件列表 */}
      {adapter && ctx && (
        <div style={{ marginTop: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            <button style={{ ...btn(), padding: '3px 8px' }} disabled={busy} onClick={() => void goBack(stack.length - 2)}>
              ← 返回
            </button>
            <span style={muted}>
              {title || adapter.name}
              {stack.map((s) => ` / ${s.name}`).join('')}
            </span>
            <span style={{ ...muted, marginLeft: 'auto' }}>{entries.length} 项</span>
          </div>

          <div
            style={{
              border: '1px solid var(--border-subtle)',
              borderRadius: 8,
              maxHeight: 220,
              overflow: 'auto',
            }}
          >
            {entries.length === 0 && <div style={{ ...muted, padding: 12 }}>（空目录）</div>}
            {entries.map((e) => (
              <div
                key={e.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 10px',
                  borderBottom: '1px solid var(--border-subtle)',
                }}
              >
                <input
                  type="checkbox"
                  checked={!!selected[e.id]}
                  onChange={(ev) => setSelected((s) => ({ ...s, [e.id]: ev.target.checked }))}
                />
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {e.isDir ? '📁 ' : '📄 '}
                  {e.name}
                </span>
                <span style={{ ...muted, minWidth: 64, textAlign: 'right' }}>
                  {e.isDir ? '文件夹' : fmtSize(e.size)}
                </span>
                {e.isDir ? (
                  <button style={{ ...btn(), padding: '2px 8px' }} disabled={busy} onClick={() => void enterDir(e)}>
                    打开
                  </button>
                ) : (
                  <button style={{ ...btn(true), padding: '2px 8px' }} disabled={busy} onClick={() => void download([e])}>
                    下载
                  </button>
                )}
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <button
              style={btn()}
              onClick={() => {
                const all: Record<string, boolean> = {}
                for (const e of entries) all[e.id] = true
                setSelected(all)
              }}
            >
              全选
            </button>
            <button style={btn()} onClick={() => setSelected({})}>
              取消选择
            </button>
            <button
              style={btn(true)}
              disabled={busy || selectedEntries.length === 0}
              onClick={() => void download(selectedEntries)}
            >
              下载选中 {selectedEntries.length ? `(${selectedEntries.length})` : ''}
            </button>
          </div>
        </div>
      )}

      {/* 下载队列 */}
      <div style={{ marginTop: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={{ fontWeight: 600 }}>下载队列</span>
          {runningCount > 0 && <span style={{ ...muted, color: 'var(--accent)' }}>{runningCount} 个进行中</span>}
          {runningCount > 0 && (
            <span
              style={muted}
              title="插件只在面板打开时轮询任务状态：关掉面板后如果直链过期，就没有人来重新解析了"
            >
              长任务请保持本面板打开
            </span>
          )}
          <button
            style={{ ...btn(), marginLeft: 'auto', padding: '3px 8px' }}
            onClick={() => persistHidden([...hidden, ...jobs.filter((j) => j.state !== 'running').map((j) => j.id)])}
          >
            清除已完成
          </button>
        </div>

        {visibleJobs.length === 0 && <div style={muted}>还没有下载任务。</div>}
        {visibleJobs.map((j) => {
          const pct = j.total > 0 ? Math.min(100, (j.downloaded / j.total) * 100) : 0
          const stateText =
            j.state === 'done'
              ? '已完成'
              : j.state === 'expired'
                ? '直链过期，换链中…'
                : j.state === 'failed'
                  ? '失败'
                  : j.state === 'cancelled'
                    ? '已取消'
                    : `${pct.toFixed(1)}%`
          return (
            <div
              key={j.id}
              style={{
                border: '1px solid var(--border-subtle)',
                borderRadius: 8,
                padding: '7px 10px',
                marginBottom: 6,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={j.path}>
                  {j.fileName}
                </span>
                <span style={{ ...muted, minWidth: 130, textAlign: 'right' }}>
                  {fmtSize(j.downloaded)}
                  {j.total > 0 ? ` / ${fmtSize(j.total)}` : ''} · {fmtSpeed(j.speed)}
                  {j.state === 'running' && j.total > 0 ? ` · 剩 ${fmtEta(j.downloaded, j.total, j.speed)}` : ''}
                </span>
                {j.state === 'running' ? (
                  <button
                    style={{ ...btn(), padding: '2px 8px' }}
                    onClick={() => void invoke('netdisk_download_cancel', { id: j.id })}
                  >
                    取消
                  </button>
                ) : (
                  <button
                    style={{ ...btn(), padding: '2px 8px' }}
                    onClick={() => void invoke('netdisk_reveal_in_explorer', { path: j.path }).catch(() => {})}
                  >
                    打开位置
                  </button>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 5 }}>
                <div
                  style={{
                    flex: 1,
                    height: 5,
                    borderRadius: 3,
                    background: 'var(--border-subtle)',
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      width: `${pct}%`,
                      height: '100%',
                      background: j.state === 'failed' ? '#d9534f' : 'var(--accent)',
                      transition: 'width 300ms ease-out',
                    }}
                  />
                </div>
                <span style={{ ...muted, minWidth: 72, textAlign: 'right' }}>
                  {stateText}
                  {j.connections > 1 ? ` · ${j.connections}连接` : ''}
                </span>
              </div>
              {j.error && (
                <div style={{ ...muted, color: '#d9534f', marginTop: 4, whiteSpace: 'pre-wrap' }}>{j.error}</div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** 递归展开目录，收集要下载的文件及其相对目录 */
async function collectFiles(
  adapter: Adapter,
  ctx: ShareCtx,
  entry: FileEntry,
  relDir: string,
  out: { entry: FileEntry; relDir: string }[],
  depth: number
) {
  if (!entry.isDir) {
    out.push({ entry, relDir })
    return
  }
  if (depth >= 6) throw new Error('目录层级过深（超过 6 层），已停止展开')
  const kids = await adapter.list(ctx, entry.id)
  const next = relDir ? `${relDir}/${safeName(entry.name)}` : safeName(entry.name)
  for (const k of kids) {
    await collectFiles(adapter, ctx, k, next, out, depth + 1)
  }
}

// ═══════════════════════════ 设置面板 ═══════════════════════════

interface SettingsProps {
  settings: Settings
  onChange: (s: Settings) => void
  onPickDir: () => void
  cookieDraft: Record<string, string>
  setCookieDraft: Dispatch<SetStateAction<Record<string, string>>>
  cookieSaved: Record<string, string[]>
  setCookieSaved: Dispatch<SetStateAction<Record<string, string[]>>>
  onSaveCookie: (a: Adapter) => void
  onError: (s: string | null) => void
  onNotice: (s: string | null) => void
}

function SettingsPanel(props: SettingsProps) {
  const { settings, onChange } = props
  const [open, setOpen] = useState<string | null>(null)

  const checkCookies = async (a: Adapter) => {
    try {
      const names = await invoke<string[]>('netdisk_cookie_list', { session: a.session })
      props.setCookieSaved((s) => ({ ...s, [a.id]: names }))
      props.onNotice(names.length ? `${a.name}：已保存 ${names.length} 个 Cookie 字段` : `${a.name}：还没有保存任何 Cookie`)
    } catch (e) {
      props.onError(e instanceof Error ? e.message : String(e))
    }
  }

  const clearCookies = async (a: Adapter) => {
    try {
      await invoke('netdisk_cookie_clear', { session: a.session })
      props.setCookieSaved((s) => ({ ...s, [a.id]: [] }))
      props.onNotice(`已清除 ${a.name} 的登录信息`)
    } catch (e) {
      props.onError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div
      style={{
        marginTop: 10,
        padding: 10,
        borderRadius: 8,
        border: '1px solid var(--border-subtle)',
        background: 'var(--bg-surface)',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      {/* 下载目录 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ minWidth: 60 }}>保存到</span>
        <input
          style={{ ...inputStyle, flex: 1 }}
          value={settings.destDir}
          onChange={(e) => onChange({ ...settings, destDir: e.target.value })}
        />
        <button style={btn()} onClick={props.onPickDir}>
          选择…
        </button>
      </div>

      {/* 并发数 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ minWidth: 60 }}>并发连接</span>
        <select
          style={{ ...inputStyle, width: 90 }}
          value={settings.connections}
          onChange={(e) => onChange({ ...settings, connections: Number(e.target.value) })}
        >
          {[1, 2, 4, 8, 16, 24, 32, 48, 64].map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <span style={muted}>
          服务端按"连接"限速时（夸克/UC/蓝奏云）加连接就加总速度，建议 16–32；
          账号级限速的网盘（百度）加多少都没用
        </span>
      </div>

      {/* Cookie 管理 */}
      <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 8 }}>
        <div style={{ ...muted, marginBottom: 6 }}>
          登录信息（在浏览器打开对应网盘，从开发者工具里复制 Cookie 粘贴到下面）
        </div>
        {ADAPTERS.filter((a) => a.id !== 'direct').map((a) => (
          <div key={a.id} style={{ marginBottom: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ minWidth: 76 }}>
                {a.icon} {a.name}
              </span>
              <button style={{ ...btn(), padding: '3px 8px' }} onClick={() => setOpen(open === a.id ? null : a.id)}>
                {open === a.id ? '收起' : '设置登录'}
              </button>
              <button style={{ ...btn(), padding: '3px 8px' }} onClick={() => void checkCookies(a)}>
                检查
              </button>
              <button style={{ ...btn(), padding: '3px 8px' }} onClick={() => void clearCookies(a)}>
                清除
              </button>
              {props.cookieSaved[a.id] && (
                <span style={muted}>{props.cookieSaved[a.id].length} 项已保存</span>
              )}
            </div>
            {open === a.id && (
              <div style={{ marginTop: 6 }}>
                {a.loginHint && <div style={{ ...muted, marginBottom: 4 }}>{a.loginHint}</div>}
                <textarea
                  style={{ ...inputStyle, height: 56, fontFamily: 'monospace', fontSize: 11 }}
                  placeholder="粘贴 Cookie 原文，例如：__uid=xxx; __puus=yyy"
                  value={props.cookieDraft[a.id] || ''}
                  onChange={(e) => props.setCookieDraft((d) => ({ ...d, [a.id]: e.target.value }))}
                />
                <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                  <button style={btn(true)} onClick={() => props.onSaveCookie(a)}>
                    保存
                  </button>
                  <span style={muted}>只保存在本机（Rust 侧内存 + 本地请求），不会外发</span>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* 能力矩阵：把"能不能免费高速"讲清楚，而不是让用户自己猜 */}
      <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 8 }}>
        <div style={{ ...muted, marginBottom: 4, fontWeight: 600 }}>免费下载速度的真实情况</div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
          <thead>
            <tr style={muted}>
              <th style={{ textAlign: 'left', padding: '2px 4px' }}>网盘</th>
              <th style={{ textAlign: 'left', padding: '2px 4px' }}>免费速度</th>
              <th style={{ textAlign: 'left', padding: '2px 4px' }}>能否靠多线程加速</th>
            </tr>
          </thead>
          <tbody>
            {[
              ['夸克网盘', '按连接限速', '✅ 能，多连接可叠加（16–32 连接）'],
              ['蓝奏云', '官方不限速', '✅ 能，可跑满带宽'],
              ['任意直链', '取决于服务端', '✅ 支持 Range 就能'],
              ['百度网盘', '账号级聚合限速', '❌ 加多少连接总量都不变'],
            ].map((row) => (
              <tr key={row[0]}>
                <td style={{ padding: '2px 4px' }}>{row[0]}</td>
                <td style={{ padding: '2px 4px' }}>{row[1]}</td>
                <td style={{ padding: '2px 4px' }}>{row[2]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ═══════════════════════════ 插件导出 ═══════════════════════════

const NetdiskPlugin: InfoBoardPlugin = {
  manifest: {
    id: 'netdisk',
    name: '网盘下载',
    version: '1.0.0',
    section: 'tool',
    icon: '☁️',
    description: '分享链接 → 解析目录 → 多连接高速下载',
  },
  Component: NetdiskPanel,
  onInit: () => console.log('[网盘下载] 插件已加载'),
  onDestroy: () => console.log('[网盘下载] 插件已卸载'),
}

export default NetdiskPlugin
