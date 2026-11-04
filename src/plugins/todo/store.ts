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
 * 持久化：**单一数据源是 `todo.json`**（CLI / 脚本也会直接改它），
 * 具体怎么读怎么写收在 `backend.ts`（文件后端 / 浏览器兜底两套实现）。
 * 这一层只负责：
 * 1. `hydrate()` 异步读一次快照，记下 `rev`
 * 2. mutator 同步改内存 → 异步全量 `todo_commit`（**同步返回**，UI 不用等盘）
 * 3. 轮询 `todo_snapshot`，`rev` 变了才覆盖内存（让 CLI 的外部改动可见）
 * 4. 一次性把老的 `localStorage['todo-list']` 迁进 `todo.json`
 * 5. 损坏 → 只读（`corrupt: true`），所有 mutator 直接 return；
 *    但轮询**继续读**，文件被修好后自动退出只读（不用重开窗口）
 *
 * 这里**不存筛选状态**：筛选是每个视图自己的临时 UI 状态（卡片 vs 详细管理窗口
 * 各筛各的），放进单例会互相串台 —— 窗口切到"已完成"，卡片也跟着只剩已完成项。
 *
 * 跨窗口同步：文件后端靠轮询（见 TODO_POLL_INTERVAL_MS）；浏览器兜底仍靠 `storage` 事件
 * （两个窗口同源，`todo.json` 那条路外部改动根本不派发浏览器事件）。
 */

import { create } from 'zustand'
import type { StoreApi, UseBoundStore } from 'zustand'
import type { Todo, TodoPatch } from './types'
import { backupCorruptRaw, getTodoBackend, markLegacyMigrated, readLocalRaw } from './backend'
import type { TodoSnapshot } from './backend'
import {
  TODO_STORAGE_KEY,
  normalizeTodo,
  parseDeadlinePatch,
  parseDeadlineToDayEnd,
} from './utils'

/** 当前生效的持久化后端（`browser` 意味着"跑在浏览器兜底里"，仅开发 / 自动化测试） */
export { TODO_BACKEND } from './backend'

/**
 * 外部改动轮询间隔（毫秒）
 *
 * CLI 写完 `todo.json` 后我们得看得见。1.5s 是"人感觉不到延迟"和"别把 IPC 打爆"
 * 的折中：一次 `todo_snapshot` 就是读一个小 JSON 文件，代价可以忽略。
 */
export const TODO_POLL_INTERVAL_MS = 1500

// ───────────────────────────── 模块级状态 ─────────────────────────────

/**
 * hydrate 的幂等闩锁放模块级而不是组件 ref：
 * 卡片 + 详情页 + 独立窗口都会调 `hydrate()`，模块级才能保证全进程只读一次快照、
 * 只起一个轮询定时器。存 Promise 而不是 boolean：并发的第二次调用会**复用同一次**
 * 读盘（`await` 同一条链），不会出现"两个 hydrate 交错 set"。
 */
let hydratePromise: Promise<void> | null = null

/**
 * 轮询定时器。**故意不提供 stop**：store 是进程级的，跟窗口/组件生命周期不是一回事
 * （卡片卸载了，独立窗口还在；独立窗口关了，主窗口还在）。
 * 停定时器需要一个"谁算最后一个订阅者"的引用计数，而停错了就要么丢外部改动、
 * 要么重启后错过中间的写入 —— 换来的是每个 1.5s 一次的文件读，不划算。
 * 窗口真的销毁时整个 webview 一起没，定时器跟着消失。
 */
let pollTimer: ReturnType<typeof setInterval> | undefined

/**
 * 正在飞 / 排队中的 `todo_commit` 数量
 *
 * 用途：轮询时如果本地正好有一次提交没回来，**跳过这一轮**。
 * 否则"提交前读到的旧快照"或"提交后读到的、其实是我自己刚写的内容"都会被
 * 误判成外部改动，把用户刚看到的列表弹回去（或触发一次没必要的重渲染）。
 *
 * 用计数而不是布尔：连续两次操作（新增后立刻勾掉）会短暂重叠 ——
 * 串行链只保证落盘顺序，不减少"排队 + 在飞"的条数。
 */
let pendingCommits = 0

/**
 * 写盘串行链 —— **调用顺序 = 落盘顺序**
 *
 * 为什么必须串行（丢更新场景）：
 * Rust 侧的 `todo_commit` 是"整表覆盖 + 写前重读对齐 rev"。两次快速操作
 * （新增后立刻勾掉）如果并发发出两个 commit，两笔写会交错：后落盘的那笔
 * 可能是**先发出去的、内容更旧**的那份快照 —— 整表覆盖之后，用户刚做的那一步
 * 就被悄悄回滚了（而且两边都"成功"，没有任何报错可循）。
 * 排成一条链之后，"每次提交的内容都是当时最新的内存快照"这一点才成立。
 *
 * 链本身用 `Promise.resolve()` 起头，且**永不 reject**（见 persist 里的 `.catch`）：
 * 一次写盘失败不能让后续操作再也发不出提交。
 */
let commitChain: Promise<unknown> = Promise.resolve()

/** 损坏提示只弹一次（StrictMode 双跑 / 多个挂载点重复 hydrate 的兜底） */
let corruptNotified = false

/**
 * "已恢复"提示只弹一次
 *
 * 自愈本身是状态跃迁（`corrupt: true → false`），正常情况下只会发生一次；
 * 但两轮轮询可能同时读到"文件已经修好"（前一轮的 await 还没回来，下一轮已经发出去了），
 * 显式闩锁一下，别让用户连吃两条一样的绿条。
 *
 * 注意：**故意不重置** `corruptNotified`。同一进程里数据再坏一次时不再重复弹
 * "损坏"提示（那条提示信息量大、弹过一次用户已经知道去哪修），
 * 也就没有"再弹一次已恢复"的必要 —— 两个闩锁都是进程级的。
 */
let corruptRecoveredNotified = false

/** 跨窗口（浏览器兜底）的 storage 监听只绑一次 */
let storageListenerBound = false

// ───────────────────────────── 小工具 ─────────────────────────────

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

/** 把 reject 出来的东西转成可读文案（Rust 侧 reject 的是字符串） */
function describeError(err: unknown): string {
  if (typeof err === 'string') return err
  if (err instanceof Error) return err.message
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

/** 是否具备监听 storage 事件的能力（单测里的 window 常常只是个带 toastAPI 的桩） */
function canListenStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.addEventListener === 'function'
}

// ───────────────────────────── store 形状 ─────────────────────────────

export interface TodoStore {
  /** 全量待办（未筛选、未排序；派生列表由 useTodo 计算） */
  todos: Todo[]
  /**
   * 数据源是否损坏（**只读态**）
   *
   * - 文件后端：`todo_snapshot` reject（`todo.json` 不是合法 JSON / 读不出来）
   * - 浏览器兜底：`localStorage['todo-list']` 解析失败
   * - 迁移时旧数据解析失败也算（原文没敢动，进了只读）
   *
   * 为 true 时所有 mutator 直接 return：不写盘、也不弹"保存失败"（那不是用户的错）。
   *
   * **可自愈**：文件后端下轮询不会因为只读就停手，它每一轮都试读一次；
   * 用户把 `todo.json` 修好（或从备份恢复）后，下一轮轮询就会把 `corrupt` 翻回 false
   * 并弹一次"已恢复"。不需要关窗口重开。
   */
  corrupt: boolean
  /** 最近一次已知的数据版本号（文件后端来自 `todo_snapshot` / `todo_commit` 的返回值） */
  rev: number
  /**
   * 异步读一次快照 + 启动外部改动轮询 + 一次性迁移老 localStorage。
   * 重复调用复用同一个 Promise（幂等）；失败不会 reject（内部转成只读态）。
   */
  hydrate: () => Promise<void>
  /** 添加待办，返回新建项；被拒绝（空文本 / 只读态）时返回 undefined */
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
  /**
   * 当前数据到底存在哪（排障 / QA 用）
   *
   * 文件后端 → `todo.json` 的绝对路径；浏览器兜底 → `localStorage://todo-list`。
   * 想知道"现在走的是哪条分支"，看这个返回值就够了（它就是后端自己报的）。
   */
  dataPath: () => Promise<string>
}

export const useTodoStore: UseBoundStore<StoreApi<TodoStore>> = create<TodoStore>()((set, get) => {
  /**
   * 落盘：全量提交，**同步返回、异步写**
   *
   * 为什么要异步：写 `todo.json` 要过 IPC + 原子写盘，同步不了；而 mutator 必须同步返回
   * （`deleteTodo` 的返回值是 UI 做撤销的唯一依据）。所以内存立刻改、盘在后台跟上。
   *
   * 失败：弹 toast，**内存状态不回滚** —— 回滚会让界面"自己弹回去"，
   * 比"这次改动可能丢"更难理解；用户看到提示后自己决定要不要重做。
   *
   * 串行：提交排进 `commitChain`，等上一笔落盘（成功或失败）再发下一笔。
   * 理由见模块级 `commitChain` 的注释（并发全量覆盖会丢更新）。
   */
  const persist = (next: Todo[]): void => {
    const backend = getTodoBackend()
    // 语义仍是"排队 + 在飞"的条数：排队中的也算，轮询照样跳过
    pendingCommits += 1

    // 排队：上一笔落盘之后才发这一笔 —— 保证落盘顺序 = 用户操作顺序
    const task = commitChain.then(() => backend.commit(next))
    // 链不能断：这一笔失败也要让后续操作继续能写（这里只把失败"接住"，不重抛）
    commitChain = task.catch(() => undefined)

    task
      .then((rev) => {
        // 落盘成功：把新 rev 记成基准，轮询据此判断"后面的是不是外部改动"。
        // 取 max：万一两笔返回的 rev 乱序（或后端重载后 rev 回退），
        // 也不能把基准往回拉 —— 拉回去只会让下一轮轮询把同一份内容再 set 一遍，
        // 更糟的是可能把真正的外部改动判成"我自己写的"而漏掉。
        set({ rev: Math.max(get().rev, rev) })
      })
      .catch((err: unknown) => {
        showToast(`待办保存失败：${describeError(err)}`, '#ef4444')
      })
      .finally(() => {
        pendingCommits -= 1
      })
  }

  /** 进入只读态：清空内存列表 + 只提示一次 */
  const enterCorrupt = (message: string): void => {
    if (!corruptNotified) {
      corruptNotified = true
      showToast(message, '#f59e0b')
    }
    set({ todos: [], corrupt: true })
  }

  /**
   * 轮询一次：**只有 `rev` 变了才覆盖内存**；只读态则尝试自愈
   *
   * - 本地有 commit 在飞 → 整轮跳过（那是自己的写，不是外部改动）
   * - 只读态（`corrupt`）→ **继续读**，读成功就退出只读（见下）
   * - rev 相同 → 什么都不做（不然每次轮询都 set 一个新数组，整棵树重渲染）
   * - 轮询失败（文件正在被 CLI 原子替换 / 临时读不到）→ 保持现状，下一次再试；
   *   **不**把读失败当损坏，否则 CLI 每写一次界面就闪一次只读态
   */
  const pollOnce = async (): Promise<void> => {
    if (pendingCommits > 0) return
    const state = get()

    if (state.corrupt) {
      // 只读态也要试一次：文件坏了不等于永远坏 —— 用户可能已经手工修好 JSON、
      // 或者从备份恢复回来了。不试就永远卡在只读，只能关窗口重开（体验灾难）。
      let recovered: TodoSnapshot
      try {
        recovered = await getTodoBackend().read()
      } catch {
        // 还坏着：保持只读，下一轮再试
        return
      }
      // 读的过程中本地又有写发出（只读态理论上不会有，防一手）
      if (pendingCommits > 0) return
      set({
        todos: recovered.todos.map((t) => normalizeTodo(t)),
        // rev 必须一起对齐：否则下一轮会把它当"外部改动"再 set 一遍（无害但多余）
        rev: recovered.rev,
        corrupt: false,
      })
      if (!corruptRecoveredNotified) {
        corruptRecoveredNotified = true
        showToast('待办数据已恢复，可以继续编辑', '#22c55e')
      }
      return
    }

    let snapshot: TodoSnapshot
    try {
      snapshot = await getTodoBackend().read()
    } catch {
      return
    }
    // 读的过程中本地又发起了写：这次快照已经过时，丢掉
    if (pendingCommits > 0) return
    if (snapshot.rev === get().rev) return

    set({ todos: snapshot.todos.map((t) => normalizeTodo(t)), rev: snapshot.rev })
  }

  /** 起轮询定时器（幂等：hydrate 会被多个挂载点反复调用） */
  const startPolling = (): void => {
    if (pollTimer !== undefined) return
    pollTimer = setInterval(() => {
      void pollOnce()
    }, TODO_POLL_INTERVAL_MS)
  }

  /**
   * 跨窗口同步（**仅浏览器兜底**）：另一个窗口改了 `todo-list` 就重读
   *
   * 文件后端不需要它：`todo.json` 的写入不派发浏览器 `storage` 事件，
   * 那边用的是轮询。这里保留是为了"浏览器兜底语义与迁移前一致"。
   */
  const bindStorageListener = (): void => {
    if (storageListenerBound) return
    storageListenerBound = true
    if (!canListenStorage()) return

    window.addEventListener('storage', (event: StorageEvent) => {
      // `key === null` 表示整个 localStorage 被清空（另一个窗口调了 clear()），同样要重读
      if (event.key !== null && event.key !== TODO_STORAGE_KEY) return
      void (async () => {
        try {
          const snapshot = await getTodoBackend().read()
          // 损坏态：**不**把空列表灌进内存 —— 保持"读取失败、只读"的语义，
          // 原始字符串继续躺在 todo-list 里等人工抢救
          if (get().corrupt) return
          set({ todos: snapshot.todos.map((t) => normalizeTodo(t)) })
        } catch {
          /* 另一个窗口写坏了：留给下一次 hydrate / 重开窗口时的只读分支处理 */
        }
      })()
    })
  }

  /**
   * 一次性迁移老的 `localStorage['todo-list']`
   *
   * 只在**文件后端 + `rev === 0`（文件还不存在）**时走：
   * `rev > 0` 说明已经迁过了（或者本来就是文件数据），再读 localStorage 只会
   * 把"上一台机器 / 上一个版本"的旧列表又盖回来。
   *
   * @returns 迁移后是否要重新读快照
   */
  const migrateLegacy = async (): Promise<boolean> => {
    const raw = readLocalRaw()
    if (raw === null) return false

    try {
      const importedRev = await getTodoBackend().importLegacy(raw)
      // null = Rust 侧判定文件已存在，本次没生效：原文留着不动，下次也不会再试（rev 已 > 0）
      if (importedRev === null) return false
      markLegacyMigrated(raw)
      showToast('已把本地待办迁移到 todo.json', '#22c55e')
      return true
    } catch (err) {
      // 解析不了：**绝不删除、不覆盖原文**，只另存一份备份并进只读态等人工处理
      backupCorruptRaw(raw)
      enterCorrupt(
        `本地待办数据损坏，已保留原始数据未覆盖${err ? `（${describeError(err)}）` : ''}`
      )
      return false
    }
  }

  /** 真正干活的那半截 hydrate（`hydrate()` 只负责让它的 Promise 唯一） */
  const runHydrate = async (): Promise<void> => {
    const backend = getTodoBackend()

    let snapshot: TodoSnapshot
    try {
      snapshot = await backend.read()
    } catch (err) {
      if (backend.kind === 'browser') {
        // 浏览器兜底：原文还躺在 todo-list 里，先备份再提示（绝不覆盖）
        backupCorruptRaw(readLocalRaw())
        enterCorrupt('本地待办数据损坏，已保留原始数据未覆盖')
      } else {
        // toast 只说"出事了 + 去哪看详情"：完整 Rust 报错里有 Windows 绝对路径这类
        // 没有空格的超长 token，铺到一条 4 秒就消失的横幅上既撑破布局、又根本读不完。
        // 原文不丢，留在 console 里给排障用；窗口里的横幅负责给出可操作的信息。
        console.error('[待办插件] 读取失败:', err)
        enterCorrupt('待办数据读取失败，已进入只读模式（详情见待办窗口）')
        // 只读态也要把轮询起起来：否则用户修好文件后没有任何东西会去重读，
        // 界面永远卡在只读（只能关窗口重开）。自愈逻辑见 pollOnce 的只读分支。
        startPolling()
      }
      return
    }

    // 文件还不存在 → 看看有没有老 localStorage 数据要迁
    if (backend.kind === 'file' && snapshot.rev === 0) {
      const migrated = await migrateLegacy()
      // 迁移失败已经进了只读态，别再用"空快照"覆盖它
      if (get().corrupt) return
      if (migrated) {
        try {
          snapshot = await backend.read()
        } catch (err) {
          // 同上：迁移后重读也失败，toast 只给信号，原文进 console
          console.error('[待办插件] 读取失败:', err)
          enterCorrupt('待办数据读取失败，已进入只读模式（详情见待办窗口）')
          return
        }
      }
    }

    set({
      todos: snapshot.todos.map((t) => normalizeTodo(t)),
      rev: snapshot.rev,
      corrupt: false,
    })

    if (backend.kind === 'file') startPolling()
    else bindStorageListener()
  }

  return {
    // 初始值刻意"空着"：**模块顶层不读任何存储**（读写都推迟到 hydrate / mutator），
    // 这样 node 单测可以在 import 之前先把假后端装上。
    todos: [],
    corrupt: false,
    rev: 0,

    hydrate: () => {
      if (hydratePromise === null) hydratePromise = runHydrate()
      return hydratePromise
    },

    addTodo: (text, deadline) => {
      // 只读态：原文还没救回来，任何写都可能把它盖掉
      if (get().corrupt) return undefined

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
      if (get().corrupt) return
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
      if (get().corrupt) return
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
      if (get().corrupt) return undefined
      const current = get().todos
      // 同步读当前列表拿"删除前的快照"：消费方拿到返回值才能做撤销
      const removed = current.find((todo) => todo.id === id)
      const next = current.filter((todo) => todo.id !== id)
      set({ todos: next })
      persist(next)
      return removed
    },

    restoreTodo: (todo) => {
      if (get().corrupt) return
      const current = get().todos
      // 已经在列表里就什么都不做（连写盘都不必，"同 id 调两次仍只有一条"）
      if (current.some((t) => t.id === todo.id)) return
      const next = [...current, todo]
      set({ todos: next })
      persist(next)
    },

    clearCompleted: () => {
      if (get().corrupt) return []
      const current = get().todos
      const removed = current.filter((todo) => todo.completed)
      const next = current.filter((todo) => !todo.completed)
      // 没有已完成项：不 set 也不写盘（省一次无意义的原子写）
      if (removed.length === 0) return []
      set({ todos: next })
      persist(next)
      return removed
    },

    restoreTodos: (todos) => {
      if (get().corrupt) return
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

    dataPath: () => getTodoBackend().dataPath(),
  }
})
