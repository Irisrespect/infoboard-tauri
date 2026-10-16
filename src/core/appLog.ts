/**
 * 应用内日志控制台 — 拦截 console + 接收后端 app_log 事件
 *
 * 打包后无 DevTools 时，用 F12 / 右键菜单打开日志台排查问题。
 * 后端日志同时写入 %APPDATA%/infoboard-tauri/app.log。
 */

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

export type LogLevel = 'log' | 'info' | 'warn' | 'error' | 'debug'

export interface LogEntry {
  id: number
  level: LogLevel
  message: string
  timestamp: number
  args: string[]
  source?: 'web' | 'rust'
}

type Listener = () => void

const MAX_ENTRIES = 800
let seq = 0
// 不可变快照：每次变更都生成新数组，useSyncExternalStore 靠引用变化判断是否重渲染
let entries: readonly LogEntry[] = []
const listeners = new Set<Listener>()
let installed = false
let backendListening = false
let logFilePath: string | null = null

const original = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
}

function notify() {
  for (const l of listeners) {
    try {
      l()
    } catch {
      /* ignore */
    }
  }
}

function stringifyArg(arg: unknown): string {
  if (arg === null) return 'null'
  if (arg === undefined) return 'undefined'
  if (typeof arg === 'string') return arg
  if (typeof arg === 'number' || typeof arg === 'boolean' || typeof arg === 'bigint') {
    return String(arg)
  }
  if (arg instanceof Error) {
    return `${arg.name}: ${arg.message}${arg.stack ? `\n${arg.stack}` : ''}`
  }
  try {
    return JSON.stringify(arg)
  } catch {
    try {
      return String(arg)
    } catch {
      return '[Unserializable]'
    }
  }
}

function normalizeLevel(level: string): LogLevel {
  const l = level.toLowerCase()
  if (l === 'error' || l === 'warn' || l === 'info' || l === 'debug' || l === 'log') {
    return l
  }
  if (l === 'warning') return 'warn'
  return 'info'
}

function push(level: LogLevel, args: unknown[], source: 'web' | 'rust' = 'web') {
  const message = args.map(stringifyArg).join(' ')
  const entry: LogEntry = {
    id: ++seq,
    level,
    message,
    timestamp: Date.now(),
    args: args.map(stringifyArg),
    source,
  }
  entries =
    entries.length >= MAX_ENTRIES
      ? [...entries.slice(entries.length - MAX_ENTRIES + 1), entry]
      : [...entries, entry]
  // 重要级别同步落盘（后端文件）
  if (level === 'error' || level === 'warn' || source === 'rust') {
    void invoke('log_append_file', { level, message: `[${source}] ${message}` }).catch(() => {})
  }
  notify()
}

export function installLogConsole(): void {
  if (installed) return
  installed = true

  const wrap =
    (level: LogLevel) =>
    (...args: unknown[]) => {
      push(level, args, 'web')
      original[level](...args)
    }

  console.log = wrap('log')
  console.info = wrap('info')
  console.warn = wrap('warn')
  console.error = wrap('error')
  console.debug = wrap('debug')

  window.addEventListener('error', (e) => {
    push('error', [
      e.message || 'Uncaught Error',
      e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : '',
      e.error,
    ])
  })
  window.addEventListener('unhandledrejection', (e) => {
    push('error', ['Unhandled Promise Rejection', e.reason])
  })

  // 接收 Rust 后端 app_log
  if (!backendListening) {
    backendListening = true
    listen<{ level: string; message: string; source?: string }>('app_log', (event) => {
      const p = event.payload
      push(normalizeLevel(p.level || 'info'), [p.message], 'rust')
    }).catch((err) => {
      original.warn('[LogConsole] 监听 app_log 失败', err)
    })

    invoke<string>('log_get_path')
      .then((p) => {
        logFilePath = p
        push('info', [`[LogConsole] 日志文件: ${p}`], 'web')
      })
      .catch(() => {
        /* 非 Tauri 环境忽略 */
      })
  }

  push('info', ['[LogConsole] 应用内日志台已就绪 — 按 F12 打开（打包后同样可用）'], 'web')
}

export function getLogEntries(): readonly LogEntry[] {
  return entries
}

export function getLogFilePath(): string | null {
  return logFilePath
}

export function clearLogEntries(): void {
  entries = []
  notify()
}

export function subscribeLogs(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function formatLogLine(e: LogEntry): string {
  const t = new Date(e.timestamp)
  const time = [
    String(t.getHours()).padStart(2, '0'),
    String(t.getMinutes()).padStart(2, '0'),
    String(t.getSeconds()).padStart(2, '0'),
    String(t.getMilliseconds()).padStart(3, '0'),
  ].join(':')
  const src = e.source === 'rust' ? 'RUST' : 'WEB'
  return `[${time}] [${e.level.toUpperCase()}] [${src}] ${e.message}`
}

export function exportLogsText(): string {
  return entries.map(formatLogLine).join('\n')
}

export function appendLog(level: LogLevel, ...args: unknown[]): void {
  push(level, args, 'web')
}
