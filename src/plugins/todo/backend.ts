/**
 * 待办持久化后端 —— "数据存在哪儿"这一层的唯一出口
 *
 * 两套实现，形状完全一致（`TodoBackend`），`store.ts` 只面向接口编程：
 *
 * 1. **文件后端**（发布包 / Tauri 桌面环境）
 *    `todo.json`，读写都走 Rust 命令（契约已冻结，Rust 侧实现在 src-tauri）：
 *    - `todo_snapshot`       → `{ rev, todos }`；文件不存在 → `{ rev: 0, todos: [] }`；文件损坏 → reject
 *    - `todo_commit`         → 全量提交、原子写盘、`rev` 自增，返回新 `rev`
 *    - `todo_import_legacy`  → 把旧的 localStorage 原始串导入；仅当文件不存在时生效，返回新 rev / null
 *    - `todo_data_path`      → 数据文件路径（排障 / 界面展示用）
 *    选它的理由：CLI（以及将来的脚本）会直接改这个文件，localStorage 藏在我们自己的
 *    webview 里，外部根本够不着。
 *
 * 2. **浏览器兜底**（`window.__TAURI_INTERNALS__` 不存在时）
 *    localStorage，键仍是 `todo-list`，语义与迁移前完全一致。
 *    **仅开发 / 自动化测试用**：发布包永远有 Tauri IPC，走的是文件后端。
 *    保留它的原因：`npx vitest run`、vite 单开浏览器、以及自动化 QA 都跑在没有 IPC 的环境里，
 *    没有这条分支整个待办模块在那些环境里会立刻抛错，"前端能不能跑"就没法验了。
 *
 * 判定方式见 `hasTauriIpc()` / `TODO_BACKEND`：只看 `window.__TAURI_INTERNALS__` 在不在，
 * 不看 `import.meta.env` —— 后者在 vitest 里不好摆，前者就是 Tauri 真正注入的东西。
 */

import { invoke } from '@tauri-apps/api/core'
import type { Todo } from './types'
import { TODO_CORRUPT_KEY_PREFIX, TODO_STORAGE_KEY, loadTodoSnapshot, saveTodos } from './utils'

/** 后端读出来的快照；`rev` 是写盘版本号，用来判定"是否被外部改动过" */
export interface TodoSnapshot {
  rev: number
  todos: Todo[]
}

/** 后端种类 */
export type TodoBackendKind = 'file' | 'browser'

/**
 * 一个后端要提供的全部能力
 *
 * 全部异步：文件是真的要走 IPC。浏览器兜底也包成 Promise，
 * 让 store 里只有一条代码路径（不然同步/异步两套分支会越飘越远）。
 */
export interface TodoBackend {
  readonly kind: TodoBackendKind
  /** 读快照。文件不存在 → `{ rev: 0, todos: [] }`；数据损坏 → **reject**（字符串或 Error） */
  read: () => Promise<TodoSnapshot>
  /** 全量提交，返回新 `rev`；失败 → reject */
  commit: (todos: Todo[]) => Promise<number>
  /** 导入旧 localStorage 数据，只在文件不存在时生效；不适用 / 未生效 → null */
  importLegacy: (raw: string) => Promise<number | null>
  /** 数据文件路径（仅排障展示用；浏览器兜底给一个说明性字符串） */
  dataPath: () => Promise<string>
}

/**
 * 当前环境有没有 Tauri IPC
 *
 * Tauri v2 在注入 webview 时挂 `window.__TAURI_INTERNALS__`；纯浏览器 / node 单测没有。
 */
function hasTauriIpc(): boolean {
  if (typeof window === 'undefined') return false
  const internals = (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  return internals !== undefined && internals !== null
}

/** 当前生效的后端种类（模块加载时定一次；两种后端不会在同一个进程里来回切） */
export const TODO_BACKEND: TodoBackendKind = hasTauriIpc() ? 'file' : 'browser'

// ──────────────────────────── 文件后端 ────────────────────────────

/**
 * 文件后端：四个命令一一对应，**不在这一层做任何容错**
 *
 * 契约里 "reject" 是有意义的信息（"文件损坏" ≠ "空列表"），
 * 吞掉它会让 store 把损坏的文件当成空的、下一笔写盘就把用户数据盖没了。
 * 容错策略统一放在 `store.ts`（备份 / 只读 / toast）。
 */
export const fileBackend: TodoBackend = {
  kind: 'file',
  read: () => invoke<TodoSnapshot>('todo_snapshot'),
  commit: (todos) => invoke<number>('todo_commit', { todos }),
  importLegacy: (raw) => invoke<number | null>('todo_import_legacy', { raw }),
  dataPath: () => invoke<string>('todo_data_path'),
}

// ──────────────────────── 浏览器兜底后端 ────────────────────────

/**
 * 浏览器兜底的"rev"
 *
 * localStorage 没有版本号，这里自己数：每次 commit +1。它只服务于
 * "store 记录的基准 vs 读到的基准"这种内部比较，外部窗口的写入不会让它前进
 * （浏览器分支靠 `storage` 事件同步，不靠轮询，见 store.ts）。
 */
let browserRev = 0

/** localStorage 不可用（隐私模式 / node 里忘装桩）时的兜底异常文案 */
const BROWSER_WRITE_REJECTED = '本地存储写入被拒绝，本次改动可能丢失'

/**
 * 浏览器兜底：localStorage `todo-list`
 *
 * **仅开发 / 自动化测试用，发布包走文件后端。**
 * - 读：损坏时 reject，跟文件后端"损坏 → reject"对齐，store 只有一条容错路径
 * - 写：脏写盘（读不写、只有用户操作才写），读不到键也不创建，与迁移前的行为一致
 */
export const browserBackend: TodoBackend = {
  kind: 'browser',
  async read() {
    const snapshot = loadTodoSnapshot()
    if (snapshot.status === 'corrupt') {
      throw `localStorage['${TODO_STORAGE_KEY}'] 不是合法的 JSON 数组`
    }
    return { rev: browserRev, todos: snapshot.todos }
  },
  async commit(todos) {
    if (!saveTodos(todos)) throw new Error(BROWSER_WRITE_REJECTED)
    browserRev += 1
    return browserRev
  },
  // 兜底分支本身就用 localStorage，没有"迁到文件"这回事
  async importLegacy() {
    return null
  },
  async dataPath() {
    return `localStorage://${TODO_STORAGE_KEY}`
  },
}

/** 取当前该用的后端 */
export function getTodoBackend(): TodoBackend {
  return TODO_BACKEND === 'file' ? fileBackend : browserBackend
}

// ───────────────────── 老数据迁移用的 localStorage 工具 ─────────────────────

/** 迁移成功后旧数据的备份键（原文留档，方便回溯） */
export const TODO_MIGRATED_KEY = `${TODO_STORAGE_KEY}.migrated`

/**
 * 读 localStorage 里的原始字符串
 *
 * 用 try 包住：隐私模式 / 被策略禁用的环境里 `localStorage` 本身就可能抛。
 * 读不到就当作"没有旧数据"，绝不因为一个异常把整个 hydrate 打断。
 */
export function readLocalRaw(): string | null {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage.getItem(TODO_STORAGE_KEY)
  } catch (err) {
    console.error('[待办插件] 读取本地存储失败:', err)
    return null
  }
}

/**
 * 迁移成功：原文备份到 `todo-list.migrated`，再删掉 `todo-list`
 *
 * 顺序不能反：先备份再删 —— 中途失败也只是"多留一份原文"，不会把数据弄丢。
 */
export function markLegacyMigrated(raw: string): void {
  try {
    localStorage.setItem(TODO_MIGRATED_KEY, raw)
    localStorage.removeItem(TODO_STORAGE_KEY)
  } catch (err) {
    console.error('[待办插件] 备份 / 清理旧数据失败:', err)
  }
}

/**
 * 数据损坏：把原文另存到 `todo-list.corrupt.<时间戳>`，**不动 `todo-list` 本身**
 *
 * 恢复逻辑：原文继续躺在原处等人工抢救，用户也能从备份键里找回。
 *
 * @returns 备份键名；写不进去（或没原文）时返回 null
 */
export function backupCorruptRaw(raw: string | null): string | null {
  if (raw === null) return null
  const key = `${TODO_CORRUPT_KEY_PREFIX}${Date.now()}`
  try {
    localStorage.setItem(key, raw)
    return key
  } catch (err) {
    console.error('[待办插件] 备份损坏数据失败:', err)
    return null
  }
}
