/**
 * 待办插件数据层 —— 模块级单一数据源（zustand）
 *
 * 为什么要有这一层：
 * 信息区的待办卡片（TodoCard）、工具区的入口，以及**独立窗口**里的待办详细管理
 * （`#/todo`，见 `src-tauri/src/plugins/todowin`）都读写同一份待办，而且可能同时可见。
 * 之前 `useTodo()` 是自带 `useState` + 自带读盘的独立 hook，多个挂载点各持一份内存状态：
 * A 删一条 B 不刷新，两边各自写盘还会互相覆盖。
 * 现在状态与持久化都收在这一层，hook 只负责"排序 + 跨天信号"这些**派生态**。
 *
 * 跨窗口那部分（独立窗口 ↔ 主窗口）靠浏览器原生的 `storage` 事件，见 `bindStorageListener`。
 *
 * 这里**不存筛选状态**：筛选是每个视图自己的临时 UI 状态（卡片 vs 详细管理窗口
 * 各筛各的），放进单例会互相串台 —— 窗口切到"已完成"，卡片也跟着只剩已完成项。
 *
 * 持久化用**同步写**（mutator 里 set 完立刻 saveTodos），不挂在 effect 上：
 * effect 的执行次数受 React 调度影响（StrictMode 下会跑两遍），同步写只跟"用户操作"
 * 一一对应，既不会漏写也不会把"挂载时的空列表"覆盖到磁盘上。
 */

import { create } from 'zustand'
import type { StoreApi, UseBoundStore } from 'zustand'
import type { Todo, TodoPatch } from './types'
import {
  TODO_CORRUPT_KEY_PREFIX,
  TODO_STORAGE_KEY,
  loadTodoSnapshot,
  normalizeTodo,
  parseDeadlinePatch,
  parseDeadlineToDayEnd,
  saveTodos,
} from './utils'

// ─────────────────────── 跨窗口同步（storage 事件） ───────────────────────

/**
 * 监听是否已绑过。放模块级：`hydrate()` 会被多个挂载点重复调用，
 * 重复注册会让一次外部改动触发 N 次 set。
 */
let storageListenerBound = false

/**
 * window 是否具备监听 storage 事件的能力
 *
 * 不能只判 `typeof window === 'undefined'`：单测里的 window 常常是只带 `toastAPI`
 * 的桩对象（见 `__tests__/todoStore.test.ts`），直接 `window.addEventListener`
 * 会 TypeError，把真正要验的存储行为淹掉。
 */
function canListenStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.addEventListener === 'function'
}

/**
 * 跨窗口同步：另一个窗口改待办后重读磁盘（**绝不写盘**）
 *
 * 为什么用 `storage` 而不是自定义事件：待办详细管理已经是**独立窗口**
 * （`src-tauri/src/plugins/todowin`），而 `storage` 事件由浏览器在**同源的其他窗口**
 * 里原生派发 —— 不需要两边约定事件名、不需要"谁先挂载谁后挂载"、也不会自己收到自己的回声。
 * （之前那套 `todo:data-changed` 自定义事件是给"同窗口两个模块实例"用的，已删除。）
 */
function bindStorageListener(apply: (todos: Todo[]) => void): void {
  if (storageListenerBound) return
  storageListenerBound = true
  if (!canListenStorage()) return

  window.addEventListener('storage', (event) => {
    // `key === null` 表示整个 localStorage 被清空（另一个窗口调了 clear()），同样要重读
    if (event.key !== null && event.key !== TODO_STORAGE_KEY) return

    const snapshot = loadTodoSnapshot()
    // 损坏态：**不**把空列表灌进内存 —— 保持"读取失败、只读"的语义，
    // 原始字符串继续躺在 todo-list 里等人工抢救（跟 hydrate 的分支保持一致）
    if (snapshot.status === 'corrupt') return

    // 另一个窗口已经落过盘：这里只重读，写回去就是回声覆盖
    apply(snapshot.todos.map((t) => normalizeTodo(t)))
  })
}

export interface TodoStore {
  /** 全量待办（未筛选、未排序；派生列表由 useTodo 计算） */
  todos: Todo[]
  /** 首次挂载时读一次盘；重复调用是 no-op */
  hydrate: () => void
  /** 添加待办，返回新建项；被拒绝（空文本）时返回 undefined */
  addTodo: (text: string, deadline?: string) => Todo | undefined
  toggleTodo: (id: string) => void
  updateTodo: (id: string, patch: TodoPatch) => void
  /** 删除待办，同步返回被删掉的那条（供 UI 做撤销） */
  deleteTodo: (id: string) => Todo | undefined
  /** 撤销单条删除（按 id 去重插回） */
  restoreTodo: (todo: Todo) => void
  /** 清除所有已完成，同步返回被清掉的列表（供 UI 做撤销） */
  clearCompleted: () => Todo[]
  /** 撤销批量清理（按 id 去重插回） */
  restoreTodos: (todos: Todo[]) => void
}

/** 生成简易 UUID */
function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2)
}

/**
 * 统一 toast 出口
 *
 * 单测跑在 node 环境（没有 window），这里必须自己收口 —— 否则"写盘失败/数据损坏"
 * 这类分支在测试里会直接 ReferenceError，把真正要验的存储行为淹掉。
 */
function showToast(message: string, color: string): void {
  if (typeof window === 'undefined') return
  window.toastAPI?.show?.({ message, color })
}

/**
 * 落盘：只在"用户操作"之后调用（见各 mutator）
 *
 * 写失败必须提示用户，静默吞掉会让人以为改动已保存，实际丢数据。
 * 写成功后**不需要**广播：同源窗口之间的 localStorage `storage` 事件由浏览器原生派发
 * （见 `bindStorageListener`），自己派发只会变成一次多余的自读。
 */
function persist(next: Todo[]): void {
  if (saveTodos(next)) return
  showToast('待办保存失败：本地存储写入被拒绝，本次改动可能丢失', '#ef4444')
}

/**
 * 幂等闩锁放模块级而不是组件 ref：
 * 卡片 + 详情页两个挂载点都会调 hydrate()，模块级才能保证全进程只读一次盘。
 */
let hydrated = false
/** 损坏数据只备份一次 / 只弹一次（StrictMode 双跑 effect 的兜底） */
let backedUp = false

/** 损坏数据保护：把原始字符串另存一份再提示用户，绝不静默覆盖 */
function backupCorruptSnapshot(): void {
  if (backedUp) return
  backedUp = true
  try {
    const raw = localStorage.getItem(TODO_STORAGE_KEY)
    if (raw !== null) localStorage.setItem(`${TODO_CORRUPT_KEY_PREFIX}${Date.now()}`, raw)
  } catch (err) {
    console.error('[待办插件] 备份损坏数据失败:', err)
  }
  showToast('本地待办数据损坏，已保留原始数据未覆盖', '#f59e0b')
}

export const useTodoStore: UseBoundStore<StoreApi<TodoStore>> = create<TodoStore>()((set, get) => ({
  // 初始值刻意"空着"：**模块顶层不读 localStorage**（读写都推迟到 hydrate / mutator），
  // 这样 node 单测可以在 import 之前先把假 storage 装上。
  todos: [],

  hydrate: () => {
    // 跨窗口同步：懒注册，只绑一次（hydrate 会被卡片 / 工具区面板 / 待办窗口反复调用）
    bindStorageListener((todos) => set({ todos }))

    if (hydrated) return
    hydrated = true

    const snapshot = loadTodoSnapshot()
    // 读取分三种状态：empty / ok / corrupt。corrupt 时先备份原文，且**绝不写盘**，
    // 原始字符串继续躺在 todo-list（以及备份键）里等人工抢救。
    if (snapshot.status === 'corrupt') backupCorruptSnapshot()
    set({ todos: snapshot.todos.map((t) => normalizeTodo(t)) })
  },

  addTodo: (text, deadline) => {
    const trimmed = text.trim()
    // 空文本：直接拒绝，不产生任何状态变更与写盘
    if (!trimmed) return undefined

    const trimmedDeadline = deadline?.trim() || undefined
    const deadlineTs = trimmedDeadline ? parseDeadlineToDayEnd(trimmedDeadline) : undefined

    if (trimmedDeadline && deadlineTs === undefined) {
      showToast(`截止日期无效，已忽略：${trimmedDeadline}`, '#f59e0b')
    }

    // 能解析就存归一化后的 ISO：formatDeadline 对「7月8日」这类原文不显示年份，
    // 跨年的「1月5日」在界面上永远看不出是明年，只有 ISO 才带得出年份。拿不到就退回原文。
    const normalizedDeadline = trimmedDeadline
      ? parseDeadlinePatch(trimmedDeadline)?.deadline
      : undefined

    const newTodo: Todo = {
      id: generateId(),
      text: trimmed,
      completed: false,
      deadline: deadlineTs === undefined ? undefined : (normalizedDeadline ?? trimmedDeadline),
      deadlineTs,
      createdAt: Date.now(),
    }

    const next = [newTodo, ...get().todos]
    // 只改数据。"新增后必须可见"（别停在"已完成"筛选下看不到新条目）由各视图自己保证，
    // 筛选状态不在这一层存（见文件头注解）。
    set({ todos: next })
    persist(next)
    return newTodo
  },

  toggleTodo: (id) => {
    const next = get().todos.map((todo) =>
      todo.id === id ? { ...todo, completed: !todo.completed } : todo
    )
    set({ todos: next })
    persist(next)
  },

  /**
   * 局部编辑
   *
   * - `text` 先 trim，空串忽略（不让用户把待办改成空白）
   * - 含 `deadline` 时同步重算 `deadlineTs`；无法解析就**忽略这次 deadline 修改**，
   *   而不是清掉用户写的原文
   */
  updateTodo: (id, patch) => {
    const next = get().todos.map((todo) => {
      if (todo.id !== id) return todo
      let updated = todo

      if (patch.text !== undefined) {
        const trimmed = patch.text.trim()
        if (trimmed) updated = { ...updated, text: trimmed }
      }

      if ('deadline' in patch) {
        const parsed = parseDeadlinePatch(patch.deadline)
        if (parsed) updated = { ...updated, ...parsed }
      } else if ('deadlineTs' in patch) {
        updated = { ...updated, deadlineTs: patch.deadlineTs }
      }

      return updated
    })
    set({ todos: next })
    persist(next)
  },

  deleteTodo: (id) => {
    const current = get().todos
    // 同步读当前列表拿"删除前的快照"：消费方拿到返回值才能做撤销
    const removed = current.find((todo) => todo.id === id)
    const next = current.filter((todo) => todo.id !== id)
    set({ todos: next })
    persist(next)
    return removed
  },

  restoreTodo: (todo) => {
    const current = get().todos
    // 已经在列表里就什么都不做（连写盘都不必，"同 id 调两次仍只有一条"）
    if (current.some((t) => t.id === todo.id)) return
    const next = [...current, todo]
    set({ todos: next })
    persist(next)
  },

  clearCompleted: () => {
    const current = get().todos
    const removed = current.filter((todo) => todo.completed)
    const next = current.filter((todo) => !todo.completed)
    set({ todos: next })
    persist(next)
    return removed
  },

  restoreTodos: (todos) => {
    if (todos.length === 0) return
    const current = get().todos
    const seen = new Set(current.map((t) => t.id))
    const additions = todos.filter((t) => {
      if (seen.has(t.id)) return false
      seen.add(t.id)
      return true
    })
    // 全部已存在：不 set 也不写盘，避免无意义的一次磁盘写入
    if (additions.length === 0) return
    const next = [...current, ...additions]
    set({ todos: next })
    persist(next)
  },
}))
