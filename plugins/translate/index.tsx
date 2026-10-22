/**
 * 翻译插件（外部插件包）
 *
 * 这个插件是内置 `translate` 的**重建版**：
 * - 多引擎（小牛 / OpenAI 兼容 / DeepL / Google / MyMemory），可失败自动换引擎
 * - 翻译历史 + 收藏
 * - 源语言自动识别、一键互换
 *
 * 注意：这里**没有**截屏取字（OCR）了。v2.1 曾加过"全屏框选 → OCR → 翻译"，
 * 按需求已移除；仓库里独立的截图插件（`src/plugins/screenshot/`）不受影响，
 * 它自己那套截图 + 识别文字仍然在。
 *
 * 单文件约束（见 docs/PLUGIN_PACKAGE.md）：只能 import 白名单里的
 * `react` / `react/jsx-runtime` / `react-dom` / `@tauri-apps/api/core`，
 * 不支持相对路径、npm 包、`@tauri-apps/api/event`。
 * 所以图标是内联 SVG，样式是内联 style，持久化只用 localStorage。
 *
 * 用到的宿主命令必须在 manifest.json 的 `tauriCommands` 里声明。
 */

import type { InfoBoardPlugin, PluginComponentProps } from '@/core/types'
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

// ─────────────────────────── 常量 ───────────────────────────

const STORE_PREFS = 'translate:prefs'
const STORE_HISTORY = 'translate:history'
const STORE_FAVS = 'translate:favorites'

const HISTORY_LIMIT = 40
const FAV_LIMIT = 100

/** 凭据名（与 Rust `core::secrets` 一致；Key 永不落到 localStorage） */
const SECRET_NIUTRANS = 'niutrans'
const SECRET_OPENAI = 'translate-openai'
const SECRET_DEEPL = 'translate-deepl'

type EngineId = 'auto' | 'niutrans' | 'openai' | 'deepl' | 'google' | 'mymemory'

interface EngineDef {
  id: EngineId
  label: string
  hint: string
  /** 是否需要 Key（决定 UI 上显示"配置/已配置"） */
  needsKey: 'niutrans' | 'openai' | 'deepl' | null
}

const ENGINES: EngineDef[] = [
  { id: 'auto', label: '自动', hint: '按已配置的引擎依次尝试', needsKey: null },
  { id: 'niutrans', label: '小牛翻译', hint: '国内直连，需要 App ID + Key', needsKey: 'niutrans' },
  { id: 'openai', label: 'OpenAI 兼容', hint: '中转站 / 本地模型都行', needsKey: 'openai' },
  { id: 'deepl', label: 'DeepL', hint: '质量高，需要 Key', needsKey: 'deepl' },
  { id: 'google', label: 'Google', hint: '免 Key，可能被墙', needsKey: null },
  { id: 'mymemory', label: 'MyMemory', hint: '免 Key 兜底，限 500 字节', needsKey: null },
]

interface LangDef {
  id: string
  label: string
  /** 中文名，用于"自动识别"提示 */
  zh: string
  /** 小牛的语言代码 */
  niu: string
}

const LANGS: LangDef[] = [
  { id: 'zh', label: '中文', zh: '中文', niu: 'zh' },
  { id: 'en', label: 'English', zh: '英语', niu: 'en' },
  { id: 'ja', label: '日本語', zh: '日语', niu: 'ja' },
  { id: 'ko', label: '한국어', zh: '韩语', niu: 'ko' },
  { id: 'de', label: 'Deutsch', zh: '德语', niu: 'de' },
  { id: 'fr', label: 'Français', zh: '法语', niu: 'fr' },
  { id: 'es', label: 'Español', zh: '西班牙语', niu: 'es' },
  { id: 'pt', label: 'Português', zh: '葡萄牙语', niu: 'pt' },
  { id: 'ru', label: 'Русский', zh: '俄语', niu: 'ru' },
  { id: 'it', label: 'Italiano', zh: '意大利语', niu: 'it' },
]

function langOf(id: string): LangDef | undefined {
  return LANGS.find((l) => l.id === id)
}

/** 小牛只认它自己的代码 */
function niuLang(id: string): string {
  return langOf(id)?.niu ?? id
}

// ─────────────────────────── 偏好 ───────────────────────────

interface Prefs {
  /** 目标语言 */
  target: string
  /** 源语言：'auto' 或具体语言 id */
  from: string
  /** 选中的引擎 */
  engine: EngineId
  /** 一个引擎失败后自动换下一个 */
  autoFallback: boolean
  /** 输入停顿后自动翻译 */
  autoTranslate: boolean
  /** OpenAI 兼容 Base URL */
  openaiBase: string
  /** OpenAI 兼容模型名 */
  openaiModel: string
  /** DeepL：free / pro / 自定义地址 */
  deeplMode: string
}

const DEFAULT_PREFS: Prefs = {
  target: 'zh',
  from: 'auto',
  engine: 'auto',
  autoFallback: true,
  autoTranslate: false,
  openaiBase: 'https://api.openai.com/v1',
  openaiModel: 'gpt-4o-mini',
  deeplMode: 'free',
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.trim() ? v : fallback
}

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(STORE_PREFS)
    if (!raw) return { ...DEFAULT_PREFS }
    const p = JSON.parse(raw) as Record<string, unknown>
    const engine = ENGINES.some((e) => e.id === p.engine) ? (p.engine as EngineId) : 'auto'
    return {
      target: langOf(str(p.target, 'zh')) ? str(p.target, 'zh') : 'zh',
      from: str(p.from, 'auto'),
      engine,
      autoFallback: p.autoFallback !== false,
      autoTranslate: p.autoTranslate === true,
      openaiBase: str(p.openaiBase, DEFAULT_PREFS.openaiBase),
      openaiModel: str(p.openaiModel, DEFAULT_PREFS.openaiModel),
      deeplMode: str(p.deeplMode, 'free'),
    }
  } catch {
    return { ...DEFAULT_PREFS }
  }
}

function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(STORE_PREFS, JSON.stringify(p))
  } catch {
    /* 存不进去不影响使用 */
  }
}

// ─────────────────────────── 历史 / 收藏 ───────────────────────────

interface HistoryItem {
  id: string
  src: string
  dst: string
  from: string
  to: string
  engine: string
  at: number
}

function readList(key: string): HistoryItem[] {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return []
    const v: unknown = JSON.parse(raw)
    if (!Array.isArray(v)) return []
    return v.filter(
      (x): x is HistoryItem =>
        !!x && typeof x === 'object' && typeof (x as HistoryItem).dst === 'string'
    )
  } catch {
    return []
  }
}

function writeList(key: string, list: HistoryItem[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(list))
  } catch {
    /* 忽略配额错误 */
  }
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

/**
 * 落盘的文本上限。
 *
 * localStorage 有 5MB 的配额，而历史 40 条 + 收藏 100 条如果都存整篇长文，
 * 一次贴进来的大文档就能把配额吃满 —— 之后所有写入都会静默失败。
 * 超长文本只存前 4000 字符（回填时够用了，想看全文直接重新翻译原文）。
 */
const STORE_TEXT_LIMIT = 4000

function clip(s: string): string {
  return s.length > STORE_TEXT_LIMIT ? `${s.slice(0, STORE_TEXT_LIMIT)}…` : s
}

// ─────────────────────────── 语言识别 ───────────────────────────

/**
 * 按字符区间猜源语言。
 *
 * 只是给界面提示和"互换"用的启发式：日文里有汉字，所以必须先判假名；
 * 韩文同理先判谚文。识别不出来就当英语。
 */
function detectLang(text: string): string {
  const s = text.trim()
  if (!s) return 'en'
  if (/[\u3040-\u30ff]/.test(s)) return 'ja'
  if (/[\uac00-\ud7af\u1100-\u11ff]/.test(s)) return 'ko'
  if (/[\u4e00-\u9fff]/.test(s)) return 'zh'
  if (/[\u0400-\u04ff]/.test(s)) return 'ru'
  if (/[\u0600-\u06ff]/.test(s)) return 'ar'
  if (/[\u0e00-\u0e7f]/.test(s)) return 'th'
  return 'en'
}

/** 识别结果的展示名；不在支持列表里的语言直接给代码 */
function langLabel(id: string): string {
  if (id === 'auto') return '自动'
  return langOf(id)?.zh ?? id
}

// ─────────────────────────── 传输层 ───────────────────────────

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  if (e && typeof e === 'object') {
    const o = e as Record<string, unknown>
    if (typeof o.message === 'string') return o.message
  }
  return String(e ?? '未知错误')
}

interface WebTranslateOut {
  text: string
  from: string
  to: string
  engine: string
}

/** 调一个具体引擎，返回译文 */
async function callEngine(
  engine: EngineId,
  text: string,
  from: string,
  to: string,
  prefs: Prefs
): Promise<string> {
  if (engine === 'niutrans') {
    const res = await invoke<{ text: string }>('niutrans_translate', {
      text,
      from: from === 'auto' ? 'auto' : niuLang(from),
      to: niuLang(to),
    })
    return res.text
  }

  const res = await invoke<WebTranslateOut>('translate_web', {
    provider: engine,
    text,
    from,
    to,
    endpoint:
      engine === 'openai' ? prefs.openaiBase : engine === 'deepl' ? prefs.deeplMode : null,
    model: engine === 'openai' ? prefs.openaiModel : null,
  })
  return res.text
}

/** 单次请求的安全长度（MyMemory 只吃 500 字节） */
function chunkSize(engine: EngineId): number {
  if (engine === 'mymemory') return 400
  if (engine === 'google') return 3000
  return 3500
}

/** 按段落/句子边界切分，尽量不把一句拆两半 */
function chunkText(text: string, size: number): string[] {
  if (text.length <= size) return [text]
  const parts: string[] = []
  let rest = text
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size)
    if (cut < size * 0.4) {
      const dot = rest.lastIndexOf('. ', size)
      cut = dot > size * 0.4 ? dot + 1 : -1
    }
    if (cut < size * 0.4) cut = size
    parts.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest.trim()) parts.push(rest)
  return parts
}

/** 这个引擎现在能不能用（免 Key 的永远可用） */
function engineReady(engine: EngineId, keys: KeyState): boolean {
  switch (engine) {
    case 'niutrans':
      return keys.niutrans
    case 'openai':
      return keys.openai
    case 'deepl':
      return keys.deepl
    case 'google':
    case 'mymemory':
      return true
    default:
      return false
  }
}

/** 引擎尝试顺序：显式选择的排第一，勾了兜底就接上其余可用的 */
function engineOrder(prefs: Prefs, keys: KeyState): EngineId[] {
  const fixed: EngineId[] = ['niutrans', 'openai', 'deepl', 'google', 'mymemory']

  if (prefs.engine === 'auto') {
    const ready = fixed.filter((e) => engineReady(e, keys))
    return ready.length ? ready : fixed
  }

  const head = prefs.engine
  if (!prefs.autoFallback) return [head]
  return [head, ...fixed.filter((e) => e !== head && engineReady(e, keys))]
}

/**
 * 翻译一段文本：按引擎顺序尝试，成功即用；每个引擎内部分片顺序请求。
 *
 * 返回实际生效的引擎名 —— 界面要显示"这条是谁翻的"，否则用户不知道
 * 兜底有没有触发。
 */
async function translateText(
  text: string,
  from: string,
  to: string,
  prefs: Prefs,
  keys: KeyState,
  onProgress?: (done: number, total: number) => void
): Promise<{ text: string; engine: string; chunks: number }> {
  const order = engineOrder(prefs, keys)
  const errors: string[] = []

  for (const engine of order) {
    try {
      const parts = chunkText(text, chunkSize(engine))
      const out: string[] = []
      for (let i = 0; i < parts.length; i++) {
        onProgress?.(i, parts.length)
        out.push(await callEngine(engine, parts[i], from, to, prefs))
      }
      return { text: out.join('\n'), engine, chunks: parts.length }
    } catch (e) {
      errors.push(`${engineLabel(engine)}: ${errorText(e)}`)
    }
  }

  throw new Error(errors.length ? errors.join('\n') : '没有可用的翻译引擎')
}

function engineLabel(id: string): string {
  return ENGINES.find((e) => e.id === id)?.label ?? id
}

// ─────────────────────────── 小部件 ───────────────────────────

const SVG = {
  swap: 'M7 16V4m0 0L3 8m4-4 4 4m6 4v12m0 0 4-4m-4 4-4-4',
  copy: 'M9 9h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2ZM5 15V5a2 2 0 0 1 2-2h9',
  star: 'm12 3 2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3-5.8 3 1.1-6.5L2.6 9.8l6.5-.9L12 3Z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-13v5l3 2',
  sliders: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18Z',
  spark: 'M12 3v4m0 10v4M3 12h4m10 0h4M6.3 6.3l2.8 2.8m5.8 5.8 2.8 2.8m0-11.4-2.8 2.8m-5.8 5.8-2.8 2.8',
}

function Icon({ path, size = 14, style }: { path: string; size?: number; style?: CSSProperties }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0, ...style }}
    >
      <path d={path} />
    </svg>
  )
}

const S: Record<string, CSSProperties> = {
  wrap: { display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 12px' },
  row: { display: 'flex', alignItems: 'center', gap: 6 },
  grow: { flex: 1, minWidth: 0 },
  input: {
    width: '100%',
    boxSizing: 'border-box',
    padding: '7px 9px',
    fontSize: 12,
    lineHeight: 1.5,
    color: 'var(--text-primary)',
    background: 'var(--bg-surface)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 7,
    outline: 'none',
    fontFamily: 'inherit',
  },
  textarea: {
    width: '100%',
    boxSizing: 'border-box',
    padding: '8px 10px',
    fontSize: 13,
    lineHeight: 1.5,
    color: 'var(--text-primary)',
    background: 'var(--bg-surface)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 8,
    outline: 'none',
    resize: 'none',
    fontFamily: 'inherit',
  },
  btn: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    padding: '6px 10px',
    fontSize: 12,
    fontWeight: 500,
    color: 'var(--text-secondary)',
    background: 'var(--bg-surface)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 7,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    transition: 'all .15s ease',
  },
  primary: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    padding: '7px 12px',
    fontSize: 12,
    fontWeight: 600,
    color: '#fff',
    background: 'var(--accent)',
    border: 'none',
    borderRadius: 7,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  tab: {
    padding: '4px 9px',
    fontSize: 11.5,
    fontWeight: 500,
    color: 'var(--text-muted)',
    background: 'transparent',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer',
  },
  tabActive: {
    padding: '4px 9px',
    fontSize: 11.5,
    fontWeight: 600,
    color: '#fff',
    background: 'var(--accent)',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer',
  },
  badge: {
    fontSize: 10,
    padding: '1px 6px',
    borderRadius: 999,
    border: '1px solid var(--border-subtle)',
    color: 'var(--text-muted)',
    whiteSpace: 'nowrap',
  },
  muted: { fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 },
  card: {
    padding: '9px 11px',
    background: 'var(--bg-surface)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 8,
  },
}

function Btn({
  children,
  onClick,
  disabled,
  title,
  style,
}: {
  children: ReactNode
  onClick?: () => void
  disabled?: boolean
  title?: string
  style?: CSSProperties
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      style={{
        ...S.btn,
        ...(disabled ? { opacity: 0.45, cursor: 'not-allowed' } : null),
        ...style,
      }}
    >
      {children}
    </button>
  )
}

// ─────────────────────────── 主组件 ───────────────────────────

type TabId = 'translate' | 'history' | 'favorites' | 'settings'

interface KeyState {
  niutrans: boolean
  openai: boolean
  deepl: boolean
}

export function TranslatePanel({ manifest }: PluginComponentProps) {
  const accent = manifest.color ?? 'var(--accent)'

  const [prefs, setPrefs] = useState<Prefs>(() => loadPrefs())
  const [keys, setKeys] = useState<KeyState>({ niutrans: false, openai: false, deepl: false })
  const [tab, setTab] = useState<TabId>('translate')

  const [input, setInput] = useState('')
  const [result, setResult] = useState<{ text: string; engine: string; from: string; to: string } | null>(
    null
  )
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [history, setHistory] = useState<HistoryItem[]>(() => readList(STORE_HISTORY))
  const [favs, setFavs] = useState<HistoryItem[]>(() => readList(STORE_FAVS))

  const inputRef = useRef(input)
  inputRef.current = input

  const refreshKeys = useCallback(async () => {
    const [niu, openai, deepl] = await Promise.all([
      invoke<boolean>('niutrans_has_api_key').catch(() => false),
      invoke<boolean>('secret_has', { name: SECRET_OPENAI }).catch(() => false),
      invoke<boolean>('secret_has', { name: SECRET_DEEPL }).catch(() => false),
    ])
    setKeys({ niutrans: !!niu, openai: !!openai, deepl: !!deepl })
  }, [])

  useEffect(() => {
    void refreshKeys()
    const onChange = () => void refreshKeys()
    window.addEventListener('settings:changed', onChange)
    return () => window.removeEventListener('settings:changed', onChange)
  }, [refreshKeys])

  const updatePrefs = useCallback((patch: Partial<Prefs>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch }
      savePrefs(next)
      return next
    })
  }, [])

  // ── 历史 / 收藏 ──

  const pushHistory = useCallback((item: HistoryItem) => {
    const stored: HistoryItem = { ...item, src: clip(item.src), dst: clip(item.dst) }
    setHistory((prev) => {
      const deduped = prev.filter((h) => !(h.src === stored.src && h.to === stored.to))
      const next = [stored, ...deduped].slice(0, HISTORY_LIMIT)
      writeList(STORE_HISTORY, next)
      return next
    })
  }, [])

  const toggleFav = useCallback((item: HistoryItem) => {
    setFavs((prev) => {
      const exists = prev.some((f) => f.src === clip(item.src) && f.to === item.to)
      const next = exists
        ? prev.filter((f) => !(f.src === clip(item.src) && f.to === item.to))
        : [{ ...item, id: newId(), src: clip(item.src), dst: clip(item.dst) }, ...prev].slice(
            0,
            FAV_LIMIT
          )
      writeList(STORE_FAVS, next)
      return next
    })
  }, [])

  const isFav = useCallback(
    (src: string, to: string) => favs.some((f) => f.src === clip(src) && f.to === to),
    [favs]
  )

  // ── 翻译 ──

  const runTranslate = useCallback(
    async (raw?: string) => {
      const text = (raw ?? inputRef.current).trim()
      if (!text) return

      setLoading(true)
      setError(null)
      setNotice(null)
      setResult(null)
      setProgress(null)

      const to = prefs.target
      const from = prefs.from === 'auto' ? detectLang(text) : prefs.from

      try {
        const started = Date.now()
        const out = await translateText(text, from, to, prefs, keys, (done, total) =>
          setProgress({ done, total })
        )
        const item: HistoryItem = {
          id: newId(),
          src: text,
          dst: out.text,
          from,
          to,
          engine: out.engine,
          at: Date.now(),
        }
        setResult({ text: out.text, engine: out.engine, from, to })
        pushHistory(item)
        if (out.chunks > 1) {
          setNotice(`分 ${out.chunks} 段翻译后拼接 · ${Date.now() - started}ms`)
        } else {
          setNotice(`${Date.now() - started}ms`)
        }
      } catch (e) {
        setError(errorText(e))
      } finally {
        setLoading(false)
        setProgress(null)
      }
    },
    [prefs, keys, pushHistory]
  )

  // 输入停顿自动翻译（默认关，避免误触发扣费）
  useEffect(() => {
    if (!prefs.autoTranslate) return
    const text = input.trim()
    if (text.length < 2) return
    const timer = setTimeout(() => {
      void runTranslate(text)
    }, 900)
    return () => clearTimeout(timer)
  }, [input, prefs.autoTranslate, runTranslate])

  const copy = useCallback(async (text: string) => {
    try {
      await invoke('plugin:clipboard-manager|write_text', { text })
      setNotice('已复制')
    } catch (e) {
      setError(`复制失败：${errorText(e)}`)
    }
  }, [])

  const swap = useCallback(() => {
    const detected = prefs.from === 'auto' ? detectLang(input) : prefs.from
    const nextFrom = prefs.target
    updatePrefs({ target: detected, from: nextFrom })
    if (result) {
      setInput(result.text)
    }
  }, [prefs, input, result, updatePrefs])

  // ── 派生状态 ──

  const detected = useMemo(() => detectLang(input), [input])
  const keysReady = keys.niutrans || keys.openai || keys.deepl
  const charCount = input.length

  return (
    <div style={S.wrap}>
      <TabBar tab={tab} onChange={setTab} accent={accent} />

      {tab === 'translate' && (
        <TranslateView
          accent={accent}
          prefs={prefs}
          updatePrefs={updatePrefs}
          input={input}
          setInput={setInput}
          detected={detected}
          result={result}
          loading={loading}
          progress={progress}
          error={error}
          notice={notice}
          charCount={charCount}
          keys={keys}
          keysReady={keysReady}
          onTranslate={() => void runTranslate()}
          onSwap={swap}
          onCopy={copy}
          onFav={() =>
            result &&
            toggleFav({
              id: newId(),
              src: inputRef.current,
              dst: result.text,
              from: result.from,
              to: result.to,
              engine: result.engine,
              at: Date.now(),
            })
          }
          faved={!!result && isFav(inputRef.current, result.to)}
        />
      )}

      {tab === 'history' && (
        <ListView
          accent={accent}
          items={history}
          empty="还没有翻译记录"
          onUse={(item) => {
            setInput(item.src)
            setResult({ text: item.dst, engine: item.engine, from: item.from, to: item.to })
            setTab('translate')
          }}
          onFav={toggleFav}
          isFav={isFav}
          onDelete={(id) => {
            const next = history.filter((h) => h.id !== id)
            setHistory(next)
            writeList(STORE_HISTORY, next)
          }}
          onClear={() => {
            setHistory([])
            writeList(STORE_HISTORY, [])
          }}
        />
      )}

      {tab === 'favorites' && (
        <ListView
          accent={accent}
          items={favs}
          empty="还没有收藏（译文卡片上的 ★ 就是收藏）"
          onUse={(item) => {
            setInput(item.src)
            setResult({ text: item.dst, engine: item.engine, from: item.from, to: item.to })
            setTab('translate')
          }}
          onFav={toggleFav}
          isFav={() => true}
          onDelete={(id) => {
            const next = favs.filter((f) => f.id !== id)
            setFavs(next)
            writeList(STORE_FAVS, next)
          }}
        />
      )}

      {tab === 'settings' && (
        <SettingsView
          accent={accent}
          prefs={prefs}
          updatePrefs={updatePrefs}
          keys={keys}
          refreshKeys={refreshKeys}
          setError={setError}
          setNotice={setNotice}
        />
      )}

      {error && <ErrorBox text={error} />}
    </div>
  )
}

// ─────────────────────────── 标签栏 ───────────────────────────

function TabBar({
  tab,
  onChange,
  accent,
}: {
  tab: TabId
  onChange: (t: TabId) => void
  accent: string
}) {
  const items: { id: TabId; label: string; icon: string }[] = [
    { id: 'translate', label: '翻译', icon: SVG.globe },
    { id: 'history', label: '历史', icon: SVG.clock },
    { id: 'favorites', label: '收藏', icon: SVG.star },
    { id: 'settings', label: '设置', icon: SVG.sliders },
  ]

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
      {items.map((it) => {
        const active = tab === it.id
        return (
          <button
            key={it.id}
            type="button"
            onClick={() => onChange(it.id)}
            style={{
              ...(active ? S.tabActive : S.tab),
              ...(active ? { background: accent } : null),
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            <Icon path={it.icon} size={12} />
            {it.label}
          </button>
        )
      })}
    </div>
  )
}

// ─────────────────────────── 翻译视图 ───────────────────────────

function TranslateView(props: {
  accent: string
  prefs: Prefs
  updatePrefs: (p: Partial<Prefs>) => void
  input: string
  setInput: (v: string) => void
  detected: string
  result: { text: string; engine: string; from: string; to: string } | null
  loading: boolean
  progress: { done: number; total: number } | null
  error: string | null
  notice: string | null
  charCount: number
  keys: KeyState
  keysReady: boolean
  onTranslate: () => void
  onSwap: () => void
  onCopy: (t: string) => void
  onFav: () => void
  faved: boolean
}) {
  const {
    accent,
    prefs,
    updatePrefs,
    input,
    setInput,
    detected,
    result,
    loading,
    progress,
    notice,
    charCount,
    keys,
    keysReady,
    onTranslate,
    onSwap,
    onCopy,
    onFav,
    faved,
  } = props

  return (
    <>
      {/* 语言栏：源 → 目标，中间互换 */}
      <div style={{ ...S.row, gap: 5 }}>
        <select
          value={prefs.from}
          onChange={(e) => updatePrefs({ from: e.target.value })}
          style={{ ...S.input, width: 'auto', flex: '0 1 auto', padding: '5px 6px', fontSize: 11.5 }}
          title="源语言"
        >
          <option value="auto">自动（{langLabel(detected)}）</option>
          {LANGS.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </select>

        <button
          type="button"
          onClick={onSwap}
          title="互换源/目标语言"
          style={{
            ...S.btn,
            padding: 5,
            borderRadius: 999,
            border: 'none',
            background: 'transparent',
            color: accent,
          }}
        >
          <Icon path={SVG.swap} size={15} />
        </button>

        <select
          value={prefs.target}
          onChange={(e) => updatePrefs({ target: e.target.value })}
          style={{ ...S.input, width: 'auto', flex: '0 1 auto', padding: '5px 6px', fontSize: 11.5 }}
          title="目标语言"
        >
          {LANGS.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </select>

        <span style={{ ...S.grow }} />

        <select
          value={prefs.engine}
          onChange={(e) => updatePrefs({ engine: e.target.value as EngineId })}
          style={{ ...S.input, width: 'auto', flex: '0 1 auto', padding: '5px 6px', fontSize: 11.5 }}
          title="翻译引擎"
        >
          {ENGINES.map((e) => (
            <option key={e.id} value={e.id}>
              {e.label}
              {e.needsKey && !keys[e.needsKey] ? '（未配置）' : ''}
            </option>
          ))}
        </select>
      </div>

      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault()
            if (!loading) onTranslate()
          }
        }}
        placeholder="输入要翻译的文字，Ctrl+Enter 翻译"
        rows={3}
        style={S.textarea}
        spellCheck={false}
      />

      <div style={{ ...S.row }}>
        <button
          type="button"
          onClick={onTranslate}
          disabled={loading || !input.trim()}
          style={{
            ...S.primary,
            background: accent,
            opacity: loading || !input.trim() ? 0.5 : 1,
            cursor: loading || !input.trim() ? 'not-allowed' : 'pointer',
          }}
        >
          {loading
            ? progress && progress.total > 1
              ? `翻译中 ${progress.done + 1}/${progress.total}`
              : '翻译中…'
            : '翻译'}
        </button>

        <span style={{ ...S.grow }} />

        <span
          style={{ ...S.badge, color: keysReady ? 'var(--text-muted)' : '#d97706' }}
          title={
            keysReady
              ? `可用引擎：${ENGINES.filter((e) => e.id !== 'auto' && engineReady(e.id, keys))
                  .map((e) => e.label)
                  .join('、')}`
              : '还一个 Key 都没配，只能用免 Key 引擎'
          }
        >
          {keysReady ? '已配 Key' : '未配 Key'}
        </span>
      </div>

      {result && (
        <ResultCard
          accent={accent}
          result={result}
          notice={notice}
          faved={faved}
          onCopy={onCopy}
          onFav={onFav}
          onRetranslate={onTranslate}
        />
      )}

      {!result && notice && (
        <div style={{ ...S.muted, fontSize: 11 }}>{notice}</div>
      )}

      <div style={{ ...S.muted, textAlign: 'right', fontSize: 10 }}>
        {charCount > 0 ? `${charCount} 字符 · ` : ''}
        {prefs.engine === 'auto'
          ? '引擎按可用性依次尝试'
          : prefs.autoFallback
            ? '失败时自动换下一个引擎'
            : '只用选中的引擎'}
      </div>
    </>
  )
}

// ─────────────────────────── 结果卡 ───────────────────────────

function ResultCard({
  accent,
  result,
  notice,
  faved,
  onCopy,
  onFav,
  onRetranslate,
}: {
  accent: string
  result: { text: string; engine: string; from: string; to: string }
  notice: string | null
  faved: boolean
  onCopy: (t: string) => void
  onFav: () => void
  onRetranslate: () => void
}) {
  return (
    <div style={S.card}>
      <div style={{ ...S.row, marginBottom: 6 }}>
        <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
          {langLabel(result.from)} → {langLabel(result.to)}
        </span>
        <span style={{ ...S.badge, fontSize: 9.5 }}>{engineLabel(result.engine)}</span>
        {notice && <span style={{ fontSize: 9.5, color: 'var(--text-muted)' }}>{notice}</span>}

        <span style={{ ...S.grow }} />

        <button
          type="button"
          onClick={onFav}
          title={faved ? '取消收藏' : '收藏'}
          style={{
            ...S.btn,
            padding: 4,
            border: 'none',
            background: 'transparent',
            color: faved ? accent : 'var(--text-muted)',
          }}
        >
          <Icon path={SVG.star} size={13} style={{ fill: faved ? accent : 'none' }} />
        </button>
        <button
          type="button"
          onClick={onRetranslate}
          title="重新翻译"
          style={{ ...S.btn, padding: 4, border: 'none', background: 'transparent' }}
        >
          <Icon path={SVG.spark} size={13} />
        </button>
        <Btn onClick={() => onCopy(result.text)} title="复制译文" style={{ padding: '4px 8px' }}>
          <Icon path={SVG.copy} size={12} />
          复制
        </Btn>
      </div>

      <div
        style={{
          fontSize: 13,
          lineHeight: 1.6,
          color: 'var(--text-primary)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          maxHeight: 132,
          overflow: 'auto',
        }}
      >
        {result.text}
      </div>
    </div>
  )
}

// ─────────────────────────── 列表（历史 / 收藏） ───────────────────────────

function ListView({
  accent,
  items,
  empty,
  onUse,
  onFav,
  isFav,
  onDelete,
  onClear,
}: {
  accent: string
  items: HistoryItem[]
  empty: string
  onUse: (item: HistoryItem) => void
  onFav: (item: HistoryItem) => void
  isFav: (src: string, to: string) => boolean
  onDelete: (id: string) => void
  onClear?: () => void
}) {
  if (!items.length) {
    return <div style={{ ...S.muted, padding: '14px 2px' }}>{empty}</div>
  }

  return (
    <>
      <div style={{ ...S.row, gap: 4 }}>
        <span style={{ ...S.muted, fontSize: 10.5 }}>共 {items.length} 条</span>
        <span style={{ ...S.grow }} />
        {onClear && (
          <Btn onClick={onClear} title="清空历史" style={{ padding: '3px 7px', fontSize: 11 }}>
            <Icon path={SVG.trash} size={11} />
            清空
          </Btn>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, maxHeight: 230, overflow: 'auto' }}>
        {items.map((it) => (
          <div key={it.id} style={{ ...S.card, padding: '7px 9px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                {langLabel(it.from)} → {langLabel(it.to)} · {engineLabel(it.engine)}
              </span>
              <span style={{ ...S.grow }} />
              <button
                type="button"
                onClick={() => onFav(it)}
                title={isFav(it.src, it.to) ? '取消收藏' : '收藏'}
                style={{
                  ...S.btn,
                  padding: 3,
                  border: 'none',
                  background: 'transparent',
                  color: isFav(it.src, it.to) ? accent : 'var(--text-muted)',
                }}
              >
                <Icon
                  path={SVG.star}
                  size={12}
                  style={{ fill: isFav(it.src, it.to) ? accent : 'none' }}
                />
              </button>
              <button
                type="button"
                onClick={() => onDelete(it.id)}
                title="删除"
                style={{ ...S.btn, padding: 3, border: 'none', background: 'transparent' }}
              >
                <Icon path={SVG.trash} size={12} />
              </button>
            </div>

            <div
              onClick={() => onUse(it)}
              title="点回翻译区"
              style={{
                cursor: 'pointer',
                marginTop: 3,
                fontSize: 11.5,
                color: 'var(--text-muted)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {it.src}
            </div>
            <div
              onClick={() => onUse(it)}
              title="点回翻译区"
              style={{
                cursor: 'pointer',
                marginTop: 1,
                fontSize: 12,
                color: 'var(--text-primary)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {it.dst}
            </div>
          </div>
        ))}
      </div>
    </>
  )
}

// ─────────────────────────── 设置 ───────────────────────────

function SettingsView({
  accent,
  prefs,
  updatePrefs,
  keys,
  refreshKeys,
  setError,
  setNotice,
}: {
  accent: string
  prefs: Prefs
  updatePrefs: (p: Partial<Prefs>) => void
  keys: KeyState
  refreshKeys: () => Promise<void>
  setError: (s: string | null) => void
  setNotice: (s: string | null) => void
}) {
  const [niuAppId, setNiuAppId] = useState('')
  const [niuKey, setNiuKey] = useState('')
  const [openaiKey, setOpenaiKey] = useState('')
  const [deeplKey, setDeeplKey] = useState('')
  const [saving, setSaving] = useState<string | null>(null)

  const save = useCallback(
    async (what: string, fn: () => Promise<void>) => {
      setSaving(what)
      setError(null)
      setNotice(null)
      try {
        await fn()
        await refreshKeys()
        setNotice(`${what}已保存`)
      } catch (e) {
        setError(`保存失败：${errorText(e)}`)
      } finally {
        setSaving(null)
      }
    },
    [refreshKeys, setError, setNotice]
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 250, overflow: 'auto' }}>
      {/* 行为开关 */}
      <div style={S.card}>
        <Row label="失败时自动换引擎">
          <Toggle
            accent={accent}
            checked={prefs.autoFallback}
            onChange={(v) => updatePrefs({ autoFallback: v })}
          />
        </Row>
        <Row label="输入停顿 0.9 秒自动翻译">
          <Toggle
            accent={accent}
            checked={prefs.autoTranslate}
            onChange={(v) => updatePrefs({ autoTranslate: v })}
          />
        </Row>
      </div>

      {/* 小牛 */}
      <div style={S.card}>
        <SectionTitle
          title="小牛翻译"
          ok={keys.niutrans}
          accent={accent}
          hint="国内直连，需要 App ID + API Key"
        />
        <input
          value={niuAppId}
          onChange={(e) => setNiuAppId(e.target.value)}
          placeholder="App ID"
          style={{ ...S.input, marginBottom: 5 }}
        />
        <input
          type="password"
          value={niuKey}
          onChange={(e) => setNiuKey(e.target.value)}
          placeholder={keys.niutrans ? 'API Key 已保存（输入新值替换）' : 'API Key'}
          style={{ ...S.input, marginBottom: 5 }}
        />
        <Btn
          disabled={saving !== null || (!niuAppId.trim() && !niuKey.trim())}
          onClick={() =>
            void save('小牛翻译配置', async () => {
              if (niuKey.trim()) await invoke('niutrans_set_api_key', { key: niuKey.trim() })
              if (niuAppId.trim()) await invoke('niutrans_set_app_id', { appId: niuAppId.trim() })
              setNiuKey('')
              setNiuAppId('')
            })
          }
        >
          {saving === '小牛翻译配置' ? '保存中…' : '保存小牛配置'}
        </Btn>
      </div>

      {/* OpenAI 兼容 */}
      <div style={S.card}>
        <SectionTitle
          title="OpenAI 兼容"
          ok={keys.openai}
          accent={accent}
          hint="中转站 / 本地模型：填 Base URL + 模型 + Key"
        />
        <input
          value={prefs.openaiBase}
          onChange={(e) => updatePrefs({ openaiBase: e.target.value })}
          placeholder="https://api.example.com/v1"
          style={{ ...S.input, marginBottom: 5 }}
        />
        <input
          value={prefs.openaiModel}
          onChange={(e) => updatePrefs({ openaiModel: e.target.value })}
          placeholder="gpt-4o-mini"
          style={{ ...S.input, marginBottom: 5 }}
        />
        <input
          type="password"
          value={openaiKey}
          onChange={(e) => setOpenaiKey(e.target.value)}
          placeholder={keys.openai ? 'Key 已保存（输入新值替换）' : 'API Key'}
          style={{ ...S.input, marginBottom: 5 }}
        />
        <Btn
          disabled={saving !== null || !openaiKey.trim()}
          onClick={() =>
            void save('OpenAI Key', async () => {
              await invoke('secret_set', { name: SECRET_OPENAI, value: openaiKey.trim() })
              setOpenaiKey('')
            })
          }
        >
          {saving === 'OpenAI Key' ? '保存中…' : '保存 Key'}
        </Btn>
      </div>

      {/* DeepL */}
      <div style={S.card}>
        <SectionTitle title="DeepL" ok={keys.deepl} accent={accent} hint="免费版 / 专业版都支持" />
        <div style={{ ...S.row, marginBottom: 5 }}>
          <select
            value={prefs.deeplMode}
            onChange={(e) => updatePrefs({ deeplMode: e.target.value })}
            style={{ ...S.input, width: 'auto', padding: '5px 6px' }}
          >
            <option value="free">免费版 api-free</option>
            <option value="pro">专业版 api</option>
          </select>
        </div>
        <input
          type="password"
          value={deeplKey}
          onChange={(e) => setDeeplKey(e.target.value)}
          placeholder={keys.deepl ? 'Key 已保存（输入新值替换）' : 'DeepL Auth Key'}
          style={{ ...S.input, marginBottom: 5 }}
        />
        <Btn
          disabled={saving !== null || !deeplKey.trim()}
          onClick={() =>
            void save('DeepL Key', async () => {
              await invoke('secret_set', { name: SECRET_DEEPL, value: deeplKey.trim() })
              setDeeplKey('')
            })
          }
        >
          {saving === 'DeepL Key' ? '保存中…' : '保存 Key'}
        </Btn>
      </div>

      <div style={{ ...S.muted, fontSize: 10 }}>
        所有 Key 只进 Windows 凭据管理器，前端与 localStorage 都不留明文；
        环境变量 HTTPS_PROXY 会用于所有引擎的请求。
      </div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0' }}>
      <span style={{ flex: 1, fontSize: 11.5, color: 'var(--text-secondary)' }}>{label}</span>
      {children}
    </div>
  )
}

function SectionTitle({
  title,
  ok,
  accent,
  hint,
}: {
  title: string
  ok: boolean
  accent: string
  hint: string
}) {
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>{title}</span>
        <span
          style={{
            fontSize: 9.5,
            padding: '1px 5px',
            borderRadius: 999,
            color: ok ? '#fff' : 'var(--text-muted)',
            background: ok ? accent : 'transparent',
            border: ok ? 'none' : '1px solid var(--border-subtle)',
          }}
        >
          {ok ? '已配置' : '未配置'}
        </span>
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>{hint}</div>
    </div>
  )
}

function Toggle({
  checked,
  onChange,
  accent,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  accent: string
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      style={{
        width: 30,
        height: 17,
        borderRadius: 999,
        border: 'none',
        padding: 2,
        cursor: 'pointer',
        background: checked ? accent : 'var(--border-subtle)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: checked ? 'flex-end' : 'flex-start',
        transition: 'all .15s ease',
      }}
    >
      <span
        style={{
          width: 13,
          height: 13,
          borderRadius: 999,
          background: '#fff',
          display: 'block',
        }}
      />
    </button>
  )
}

function ErrorBox({ text }: { text: string }) {
  return (
    <div
      style={{
        fontSize: 11,
        lineHeight: 1.6,
        color: '#dc2626',
        background: 'rgba(220,38,38,0.08)',
        border: '1px solid rgba(220,38,38,0.25)',
        borderRadius: 8,
        padding: '7px 9px',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        maxHeight: 110,
        overflow: 'auto',
      }}
    >
      {text}
    </div>
  )
}

// ─────────────────────────── 导出 ───────────────────────────

const TranslatePlugin: InfoBoardPlugin = {
  manifest: {
    id: 'translate',
    name: '翻译',
    version: '2.2.0',
    author: 'InfoBoard',
    description: '多引擎翻译 + 历史收藏（v2.2 移除了截屏取字）',
    section: 'tool',
    icon: 'languages',
    color: 'var(--accent)',
  },
  Component: TranslatePanel,
  onInit: () => console.log('[翻译] 插件已加载（外部插件 v2）'),
  onDestroy: () => console.log('[翻译] 插件已卸载'),
}

export default TranslatePlugin
