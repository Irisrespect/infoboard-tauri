/**
 * 待办数据层（模块级单一数据源）单测
 *
 * 数据源已从 `localStorage` 换成 `todo.json`（Tauri 命令），所以这里用一个**内存假文件**
 * 顶替 Rust 侧实现（`vi.mock('@tauri-apps/api/core')`），只按冻结的命令契约回应：
 * `todo_snapshot` / `todo_commit` / `todo_import_legacy` / `todo_data_path`。
 *
 * 隔离方式：每个用例 `vi.resetModules()` 后重新 import store —— 这样模块级的
 * `hydratePromise` / `pollTimer` / `pendingCommits` 闩锁和 store 状态都回到初始值
 * （单个 store 实例的闩锁一旦置位就无法用 setState 复位）。
 *
 * 后端选择：`window.__TAURI_INTERNALS__` 在 → 文件后端；不在 → 浏览器兜底（localStorage）。
 * 所以"文件后端"的用例要先往假 window 上挂一个空对象。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Todo } from '../plugins/todo/types'
import { TODO_CORRUPT_KEY_PREFIX, TODO_STORAGE_KEY } from '../plugins/todo/utils'
// 只取常量：用例里的轮询必须跟实现用同一个间隔。模块在装桩之前就求值也没关系 ——
// store 顶层不读任何存储，后端种类在"真正 import 的那份实例"里才重新判定。
import { TODO_POLL_INTERVAL_MS } from '../plugins/todo/store'

const h = vi.hoisted(() => {
  /** 内存假文件：todo.json */
  const file = {
    /** 文件是否存在（false → 契约要求返回 { rev: 0, todos: [] }） */
    exists: false,
    rev: 0,
    todos: [] as unknown[],
    /** 注入"文件损坏"：todo_snapshot reject */
    corrupt: false,
    /** 注入"写盘失败"：todo_commit reject */
    commitFails: false,
    /** 挂起 commit（模拟"写盘还没回来"）；null → 立即完成 */
    commitGate: null as Promise<void> | null,
    /**
     * 注入 `todo_commit` 的**返回值**（模拟乱序返回 / 后端 rev 回退）；空 → 用自增的 rev。
     * 只在"rev 单调"用例里用：串行链已经让真实乱序不可能发生，守卫仍要单独验。
     */
    commitRevs: [] as number[],
  }

  /** 全部 invoke 调用记录 */
  const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = []
  /** 假 localStorage（键 → 原始字符串） */
  const data = new Map<string, string>()
  /** 每次 getItem 的键名（用来验证"只读一次盘"） */
  const reads: string[] = []
  /** toastAPI.show 的入参 */
  const toasts: Array<{ message: string; color?: string }> = []
  /** window.addEventListener 注册的监听器（按事件名） */
  const listeners = new Map<string, Set<(event: unknown) => void>>()

  /** 深拷贝：假文件里的数组必须跟 store 内存里的数组互不影响 */
  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

  const invoke = async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
    calls.push({ cmd, args })
    switch (cmd) {
      case 'todo_snapshot': {
        if (file.corrupt) throw 'todo.json 不是合法的 JSON'
        if (!file.exists) return { rev: 0, todos: [] }
        return { rev: file.rev, todos: clone(file.todos) }
      }
      case 'todo_commit': {
        if (file.commitGate) await file.commitGate
        if (file.commitFails) throw 'todo.json 写入失败：磁盘只读'
        file.todos = clone((args?.todos ?? []) as unknown[])
        file.rev += 1
        file.exists = true
        // 返回值可以注入（模拟乱序 / rev 回退），落地内容仍按文件真实状态
        return file.commitRevs.length > 0 ? file.commitRevs.shift()! : file.rev
      }
      case 'todo_import_legacy': {
        // 契约：仅当文件不存在时生效
        if (file.exists) return null
        // 坏 JSON 走 JSON.parse 自然 reject —— 正好对上 Rust 侧"解析失败就 reject"
        const parsed = JSON.parse(String(args?.raw))
        if (!Array.isArray(parsed)) throw '旧数据不是数组'
        file.todos = parsed
        file.rev = 1
        file.exists = true
        return file.rev
      }
      case 'todo_data_path':
        return 'D:/fake/todo.json'
      default:
        throw `未知命令：${cmd}`
    }
  }

  /** 装全局桩：假 localStorage + 假 window（`ipc` 决定要不要挂 Tauri 内部对象） */
  const installGlobals = (ipc: boolean): void => {
    const g = globalThis as unknown as Record<string, unknown>
    g.localStorage = {
      getItem: (key: string) => {
        reads.push(key)
        return data.get(key) ?? null
      },
      setItem: (key: string, value: string) => void data.set(key, String(value)),
      removeItem: (key: string) => void data.delete(key),
      clear: () => data.clear(),
      key: (index: number) => Array.from(data.keys())[index] ?? null,
      get length() {
        return data.size
      },
    }

    const win: Record<string, unknown> = {
      toastAPI: {
        show: (payload: { message: string; color?: string }) => {
          toasts.push(payload)
        },
      },
      addEventListener: (type: string, handler: (event: unknown) => void) => {
        const set = listeners.get(type) ?? new Set<(event: unknown) => void>()
        set.add(handler)
        listeners.set(type, set)
      },
      removeEventListener: (type: string, handler: (event: unknown) => void) => {
        listeners.get(type)?.delete(handler)
      },
    }
    if (ipc) win.__TAURI_INTERNALS__ = {}
    g.window = win
  }

  /** 模拟浏览器在**另一个窗口**写盘后派发的 storage 事件 */
  const fireStorage = (event: { key: string | null }) => {
    for (const handler of listeners.get('storage') ?? []) handler(event)
  }

  return { file, calls, data, reads, toasts, listeners, invoke, installGlobals, fireStorage }
})

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => h.invoke(cmd, args),
}))

type StoreModule = typeof import('../plugins/todo/store')
let useTodoStore: StoreModule['useTodoStore']
/** 当前加载出来的后端种类（断言"到底走的哪条路"） */
let backendKind: 'file' | 'browser'

/** 取当前 store 状态（单测里只关心快照） */
function state() {
  return useTodoStore.getState()
}

/** 刷干净微任务队列（提交/轮询都是 Promise 链） */
async function flush(turns = 20): Promise<void> {
  for (let i = 0; i < turns; i += 1) await Promise.resolve()
}

/** 某个命令被调了几次 */
function callsOf(cmd: string) {
  return h.calls.filter((c) => c.cmd === cmd)
}

/** 假文件里当前的内容 */
function fileTodos(): Todo[] {
  return h.file.todos as Todo[]
}

/** localStorage 里 todo-list 的原始字符串 */
function rawStorage(): string | null {
  return h.data.get(TODO_STORAGE_KEY) ?? null
}

/** localStorage 里 todo-list 解析后的数组（浏览器兜底分支用） */
function storedTodos(): Todo[] {
  const raw = rawStorage()
  return raw === null ? [] : (JSON.parse(raw) as Todo[])
}

/** 备份键（todo-list.corrupt.*） */
function corruptKeys(): string[] {
  return Array.from(h.data.keys()).filter((k) => k.startsWith(TODO_CORRUPT_KEY_PREFIX))
}

/** 造一条待办 */
function mk(partial: Partial<Todo>): Todo {
  return { id: 'x', text: 't', completed: false, createdAt: 0, ...partial }
}

/** 重新装桩 + 重新加载模块（每个用例都要拿到干净的模块级闩锁） */
async function loadStore(ipc: boolean): Promise<void> {
  h.installGlobals(ipc)
  vi.resetModules()
  const mod: StoreModule = await import('../plugins/todo/store')
  useTodoStore = mod.useTodoStore
  const backend: typeof import('../plugins/todo/backend') = await import('../plugins/todo/backend')
  backendKind = backend.TODO_BACKEND
}

beforeEach(async () => {
  h.file.exists = false
  h.file.rev = 0
  h.file.todos = []
  h.file.corrupt = false
  h.file.commitFails = false
  h.file.commitGate = null
  h.file.commitRevs.length = 0
  h.calls.length = 0
  h.data.clear()
  h.reads.length = 0
  h.toasts.length = 0
  // 上一个用例的模块实例已经作废（resetModules），它注册的监听器也必须丢掉
  h.listeners.clear()
  // 默认文件后端；浏览器兜底的用例自己再 loadStore(false)
  await loadStore(true)
})

afterEach(() => {
  vi.useRealTimers()
})

// ─────────────────────────── 文件后端：hydrate ───────────────────────────

describe('hydrate（文件后端）', () => {
  it('从 todo.json 读一次快照；重复调用 hydrate 不会重读', async () => {
    expect(backendKind).toBe('file')
    h.file.exists = true
    h.file.rev = 7
    h.file.todos = [mk({ id: 'a', text: '文件里的' })]

    await state().hydrate()
    expect(state().todos.map((t) => t.id)).toEqual(['a'])
    expect(state().rev).toBe(7)
    expect(state().corrupt).toBe(false)
    expect(callsOf('todo_snapshot')).toHaveLength(1)

    // 文件被外部改动（CLI 写的）：再次 hydrate 必须是 no-op（幂等，复用同一个 Promise）
    h.file.todos = [mk({ id: 'b' })]
    h.file.rev = 8
    await state().hydrate()

    expect(state().todos.map((t) => t.id)).toEqual(['a'])
    expect(state().rev).toBe(7)
    // 排障出口：能问出"数据实际存在哪"（QA 就是靠这个确认走的是文件后端）
    await expect(state().dataPath()).resolves.toBe('D:/fake/todo.json')
    expect(callsOf('todo_snapshot')).toHaveLength(1)
  })

  it('文件不存在且没有旧数据：空列表，且一次 todo_commit 都不发（脏写盘）', async () => {
    await state().hydrate()

    expect(state().todos).toEqual([])
    expect(state().rev).toBe(0)
    expect(callsOf('todo_commit')).toHaveLength(0)
    // 文件还是不存在（读不写）
    expect(h.file.exists).toBe(false)
  })
})

// ───────────────────── 文件后端：mutator → todo_commit ─────────────────────

describe('addTodo / todo_commit（文件后端）', () => {
  it('同步返回新项；全量提交内容正确；rev 递增', async () => {
    h.file.exists = true
    h.file.rev = 3
    await state().hydrate()

    const created = state().addTodo('  买牛奶  ', '2026-03-08')

    // 同步返回：UI 不用等盘
    expect(created).toBeDefined()
    expect(created!.text).toBe('买牛奶')
    expect(state().todos).toHaveLength(1)
    expect(state().todos[0].id).toBe(created!.id)

    // 立刻进入提交队列（不挂 effect）。写盘现在是**串行链**上的一环：
    // 链空闲时也要晚一个微任务才真正发出 `todo_commit`（排队顺序 = 落盘顺序），
    // 所以这里先刷一遍微任务再看调用记录。
    await flush()
    const commits = callsOf('todo_commit')
    expect(commits).toHaveLength(1)
    const submitted = commits[0].args?.todos as Todo[]
    expect(submitted).toHaveLength(1)
    expect(submitted[0].text).toBe('买牛奶')
    expect(submitted[0].deadline).toBe('2026-03-08')
    expect(typeof submitted[0].deadlineTs).toBe('number')
    // camelCase 字段必须原样过桥（Rust 侧按这个名字反序列化）
    expect(submitted[0]).toHaveProperty('createdAt')
    expect(submitted[0]).toHaveProperty('deadlineTs')

    // 落盘成功后记下新 rev（3 → 4），作为"外部改动"的基准
    await flush()
    expect(h.file.rev).toBe(4)
    expect(state().rev).toBe(4)
    expect(fileTodos().map((t) => t.text)).toEqual(['买牛奶'])
  })

  it('空文本不新增、不提交', async () => {
    await state().hydrate()

    expect(state().addTodo('   ')).toBeUndefined()
    expect(state().addTodo('')).toBeUndefined()

    expect(state().todos).toEqual([])
    expect(callsOf('todo_commit')).toHaveLength(0)
  })

  it('非法日期：不写入该截止时间（待办本身保留）', async () => {
    await state().hydrate()
    // 2026-02-30 不存在：utils 拒绝解析（不会悄悄进位成 3 月 2 日）
    const created = state().addTodo('开会', '2026-02-30')

    expect(created).toBeDefined()
    expect(created!.deadline).toBeUndefined()
    expect(created!.deadlineTs).toBeUndefined()
    await flush()
    expect(fileTodos()[0].deadline).toBeUndefined()
    expect(h.toasts.some((t) => t.message.includes('截止日期无效'))).toBe(true)
  })

  it('提交失败：弹「待办保存失败」，内存状态不回滚', async () => {
    h.file.commitFails = true
    await state().hydrate()

    const created = state().addTodo('写不进去的')
    await flush()

    // 内存里仍在（不回滚，用户不会看到界面自己弹回去）
    expect(state().todos.map((t) => t.id)).toEqual([created!.id])
    const failure = h.toasts.find((t) => t.message.startsWith('待办保存失败：'))
    expect(failure).toBeDefined()
    expect(failure!.message).toContain('磁盘只读')
    // rev 没动（写入没落地，基准不能前进）
    expect(state().rev).toBe(0)
  })
})

describe('deleteTodo / restoreTodo / clearCompleted / restoreTodos（文件后端）', () => {
  it('deleteTodo 同步返回被删项；restoreTodo 同 id 不重复插入', async () => {
    h.file.exists = true
    h.file.rev = 1
    h.file.todos = [mk({ id: 'a', text: '甲' }), mk({ id: 'b' })]
    await state().hydrate()

    const removed = state().deleteTodo('a')

    expect(removed?.id).toBe('a')
    expect(state().todos.map((t) => t.id)).toEqual(['b'])
    await flush()
    expect(fileTodos().map((t) => t.id)).toEqual(['b'])
    // 删不存在的 id：返回 undefined（但仍然是一次全量提交 —— 状态没变，有提交也无害）
    expect(state().deleteTodo('nope')).toBeUndefined()

    state().restoreTodo(removed!)
    expect(
      state()
        .todos.map((t) => t.id)
        .sort()
    ).toEqual(['a', 'b'])

    // 同一条再撤销一次：不能重复插入
    state().restoreTodo(removed!)
    expect(state().todos.filter((t) => t.id === 'a')).toHaveLength(1)
    expect(state().todos).toHaveLength(2)
    await flush()
    expect(fileTodos()).toHaveLength(2)
  })

  it('clearCompleted 返回被清列表；restoreTodos 整批恢复（按 id 去重）', async () => {
    h.file.exists = true
    h.file.rev = 1
    h.file.todos = [
      mk({ id: 'a', completed: true }),
      mk({ id: 'b', completed: false }),
      mk({ id: 'c', completed: true }),
    ]
    await state().hydrate()

    const removed = state().clearCompleted()
    expect(removed.map((t) => t.id).sort()).toEqual(['a', 'c'])
    expect(state().todos.map((t) => t.id)).toEqual(['b'])
    await flush()
    expect(fileTodos().map((t) => t.id)).toEqual(['b'])

    state().restoreTodos(removed)
    expect(
      state()
        .todos.map((t) => t.id)
        .sort()
    ).toEqual(['a', 'b', 'c'])
    await flush()
    expect(fileTodos()).toHaveLength(3)

    // 再撤销一次：已存在的 id 全部跳过，不重复插入、也不多发一次提交
    const commitsBefore = callsOf('todo_commit').length
    state().restoreTodos(removed)
    await flush()
    expect(state().todos).toHaveLength(3)
    expect(callsOf('todo_commit')).toHaveLength(commitsBefore)
  })

  it('restoreTodos 空数组 / 全部已存在时不提交', async () => {
    h.file.exists = true
    h.file.rev = 1
    h.file.todos = [mk({ id: 'a' })]
    await state().hydrate()

    state().restoreTodos([])
    state().restoreTodos([mk({ id: 'a' })])
    await flush()

    expect(state().todos).toHaveLength(1)
    expect(callsOf('todo_commit')).toHaveLength(0)
  })
})

// ─────────────────────── 写盘串行化（防丢更新） ───────────────────────

/**
 * 为什么要有这一组：`todo_commit` 是"整表覆盖"。两次快速操作并发发出两个提交时，
 * 后落盘的可能是**内容更旧**的那份快照，用户刚做的一步被静默回滚。
 * 所以 store 里有一条模块级 Promise 链，保证"调用顺序 = 落盘顺序"。
 */
describe('写盘串行化（防丢更新）', () => {
  it('前一次提交没回来时不发下一次；落盘顺序 = 调用顺序', async () => {
    h.file.exists = true
    h.file.rev = 1
    await state().hydrate()

    // 挂住第一个提交：模拟"写盘还没回来"
    let release: () => void = () => {}
    h.file.commitGate = new Promise<void>((resolve) => {
      release = resolve
    })

    const first = state().addTodo('第一条')
    const second = state().addTodo('第二条')
    await flush()

    // 只有第一个提交发出去了：第二个排在链后面（并发发出去就会互相覆盖）
    expect(callsOf('todo_commit')).toHaveLength(1)

    // 放行第一个 → 第二个才发出
    h.file.commitGate = null
    release()
    await flush()

    expect(callsOf('todo_commit')).toHaveLength(2)
    // 最终文件内容 = 调用顺序（addTodo 是前插：第二条在前），两条都在、id 对得上
    expect(fileTodos().map((t) => t.id)).toEqual([second!.id, first!.id])
    expect(fileTodos().map((t) => t.text)).toEqual(['第二条', '第一条'])
    expect(state().todos.map((t) => t.id)).toEqual([second!.id, first!.id])
    expect(state().rev).toBe(3)
  })

  it('一次提交失败不断链：后续操作照样会发出 todo_commit', async () => {
    h.file.exists = true
    h.file.rev = 1
    await state().hydrate()

    h.file.commitFails = true
    const first = state().addTodo('会被拒绝的')
    await flush()

    expect(callsOf('todo_commit')).toHaveLength(1)
    expect(h.toasts.some((t) => t.message.startsWith('待办保存失败：'))).toBe(true)

    // 盘恢复正常：第二次操作必须还能写（链被失败断掉的话这里会一条都不发）
    h.file.commitFails = false
    const second = state().addTodo('第二次要写进去')
    await flush()

    expect(callsOf('todo_commit')).toHaveLength(2)
    expect(fileTodos().map((t) => t.id)).toEqual([second!.id, first!.id])
  })

  it('rev 单调：后返回的较小 rev 不会把基准拉回去', async () => {
    h.file.exists = true
    h.file.rev = 1
    await state().hydrate()

    // 注入"第一笔返回 9，第二笔返回 4"（乱序 / 后端 rev 回退）
    h.file.commitRevs.push(9, 4)

    state().addTodo('甲')
    await flush()
    expect(state().rev).toBe(9)

    state().addTodo('乙')
    await flush()

    // 第二笔虽然报告 rev=4，基准仍停在 9（否则下一轮轮询会把同一份内容再 set 一遍）
    expect(state().rev).toBe(9)
    expect(fileTodos()).toHaveLength(2)
  })
})

// ─────────────────────────── 外部改动（轮询） ───────────────────────────

describe('外部改动（轮询 todo_snapshot）', () => {
  it('rev 变了才覆盖内存：CLI 改完文件，下一次轮询就看见', async () => {
    h.file.exists = true
    h.file.rev = 2
    h.file.todos = [mk({ id: 'a' })]
    vi.useFakeTimers()

    await state().hydrate()
    expect(state().todos.map((t) => t.id)).toEqual(['a'])

    // 模拟 CLI 直接改文件：rev +1、内容换成 b
    h.file.rev = 3
    h.file.todos = [mk({ id: 'b', text: 'CLI 写的' })]

    await vi.advanceTimersByTimeAsync(TODO_POLL_INTERVAL_MS)
    await flush()

    expect(state().todos.map((t) => t.id)).toEqual(['b'])
    expect(state().todos[0].text).toBe('CLI 写的')
    expect(state().rev).toBe(3)
    // 轮询只读不写
    expect(callsOf('todo_commit')).toHaveLength(0)
  })

  it('rev 没变就不 set（不做无意义的重渲染）', async () => {
    h.file.exists = true
    h.file.rev = 1
    h.file.todos = [mk({ id: 'a' })]
    vi.useFakeTimers()

    await state().hydrate()
    const before = state().todos

    await vi.advanceTimersByTimeAsync(TODO_POLL_INTERVAL_MS)
    await flush()

    // 数组引用都没换 —— 说明真的没 set
    expect(state().todos).toBe(before)
    expect(callsOf('todo_snapshot').length).toBeGreaterThanOrEqual(2)
  })

  it('本地有 commit 在飞时跳过这一轮；自己的写入不会被当成外部改动', async () => {
    h.file.exists = true
    h.file.rev = 1
    h.file.todos = [mk({ id: 'a' })]
    vi.useFakeTimers()

    await state().hydrate()
    expect(callsOf('todo_snapshot')).toHaveLength(1)

    // 让 todo_commit 挂住：模拟"写盘还没回来"
    let release: () => void = () => {}
    h.file.commitGate = new Promise<void>((resolve) => {
      release = resolve
    })
    state().addTodo('本地的')

    await vi.advanceTimersByTimeAsync(TODO_POLL_INTERVAL_MS)
    await flush()

    // 整轮跳过：没有多读一次快照
    expect(callsOf('todo_snapshot')).toHaveLength(1)
    expect(state().todos).toHaveLength(2)

    // 放行写盘 → rev 基准追上文件
    h.file.commitGate = null
    release()
    await flush()
    expect(h.file.rev).toBe(2)
    expect(state().rev).toBe(2)

    // 后续轮询：rev 一致，状态不被改回
    const before = state().todos
    await vi.advanceTimersByTimeAsync(TODO_POLL_INTERVAL_MS)
    await flush()
    expect(state().todos).toBe(before)
    expect(state().todos.map((t) => t.text)).toEqual(['本地的', 't'])
  })
})

// ───────────────────────────── 损坏态（只读） ─────────────────────────────

describe('损坏态（文件后端）', () => {
  it('todo_snapshot reject → 只读：todos 清空，mutator 不提交、不弹「保存失败」', async () => {
    h.file.exists = true
    h.file.rev = 5
    h.file.corrupt = true

    await state().hydrate()

    expect(state().corrupt).toBe(true)
    expect(state().todos).toEqual([])
    expect(h.toasts.some((t) => t.message.includes('已进入只读模式'))).toBe(true)

    // 所有写操作直接 return：不写盘、不弹"保存失败"
    expect(state().addTodo('不该写')).toBeUndefined()
    expect(state().deleteTodo('a')).toBeUndefined()
    expect(state().clearCompleted()).toEqual([])
    state().toggleTodo('a')
    state().updateTodo('a', { text: '改一下' })
    state().restoreTodo(mk({ id: 'z' }))
    state().restoreTodos([mk({ id: 'y' })])
    await flush()

    expect(callsOf('todo_commit')).toHaveLength(0)
    expect(h.toasts.some((t) => t.message.startsWith('待办保存失败：'))).toBe(false)
    expect(state().todos).toEqual([])
  })

  it('文件被修好后自愈：轮询退出只读，只提示一次「已恢复」', async () => {
    h.file.exists = true
    h.file.rev = 3
    h.file.corrupt = true
    vi.useFakeTimers()

    await state().hydrate()
    expect(state().corrupt).toBe(true)
    expect(state().todos).toEqual([])
    expect(h.toasts.filter((t) => t.message.includes('已恢复'))).toHaveLength(0)

    // 用户手工修好了 todo.json（或从备份恢复）
    h.file.corrupt = false
    h.file.todos = [mk({ id: 'fixed', text: '修好了' })]
    h.file.rev = 4

    await vi.advanceTimersByTimeAsync(TODO_POLL_INTERVAL_MS)
    await flush()

    // 不用重开窗口：下一轮轮询就退出只读
    expect(state().corrupt).toBe(false)
    expect(state().todos.map((t) => t.id)).toEqual(['fixed'])
    expect(state().rev).toBe(4)
    expect(h.toasts.filter((t) => t.message.includes('已恢复'))).toHaveLength(1)

    // 再推进一轮：同一进程内"已恢复"不重复弹
    await vi.advanceTimersByTimeAsync(TODO_POLL_INTERVAL_MS)
    await flush()
    expect(h.toasts.filter((t) => t.message.includes('已恢复'))).toHaveLength(1)
    // 恢复后能正常写盘
    state().addTodo('恢复后新增的')
    await flush()
    expect(callsOf('todo_commit')).toHaveLength(1)
  })

  it('自愈后 rev 已对齐：下一轮轮询不再重复 set（数组引用不变）', async () => {
    h.file.exists = true
    h.file.rev = 3
    h.file.corrupt = true
    vi.useFakeTimers()

    await state().hydrate()
    expect(state().corrupt).toBe(true)

    h.file.corrupt = false
    h.file.todos = [mk({ id: 'fixed' })]
    h.file.rev = 4

    await vi.advanceTimersByTimeAsync(TODO_POLL_INTERVAL_MS)
    await flush()

    const healedTodos = state().todos
    expect(state().todos.map((t) => t.id)).toEqual(['fixed'])
    expect(state().rev).toBe(4)

    // 自愈那一轮把 rev 一起对齐了：再推一轮既不 set（引用不变）也不改 rev
    await vi.advanceTimersByTimeAsync(TODO_POLL_INTERVAL_MS)
    await flush()

    expect(state().todos).toBe(healedTodos)
    expect(state().rev).toBe(4)
    // 轮询确实跑了（不是"没跑才没变"）
    expect(callsOf('todo_snapshot').length).toBeGreaterThanOrEqual(3)
  })
})

// ─────────────────────────── 老数据迁移（一次性） ───────────────────────────

describe('老 localStorage 迁移', () => {
  it('rev === 0 且有旧数据：导入 todo.json、备份原文、删掉 todo-list', async () => {
    const legacy = [mk({ id: 'old', text: '老待办' })]
    const raw = JSON.stringify(legacy)
    h.data.set(TODO_STORAGE_KEY, raw)
    // 文件还不存在
    h.file.exists = false

    await state().hydrate()

    // 走的是"导入"命令，参数是原始字符串
    const imports = callsOf('todo_import_legacy')
    expect(imports).toHaveLength(1)
    expect(imports[0].args?.raw).toBe(raw)

    // 导入是 Rust 的活：store 自己不许再提交一次
    expect(callsOf('todo_commit')).toHaveLength(0)

    // 备份 + 删除旧键
    expect(h.data.get('todo-list.migrated')).toBe(raw)
    expect(h.data.has(TODO_STORAGE_KEY)).toBe(false)

    // 导入后重新读快照，内存里就是迁过来的数据
    expect(state().todos.map((t) => t.id)).toEqual(['old'])
    expect(state().rev).toBe(1)
    expect(state().corrupt).toBe(false)
    expect(h.toasts.some((t) => t.message.includes('迁移到 todo.json'))).toBe(true)
  })

  it('rev > 0 时绝不读 localStorage（已经迁过了）', async () => {
    h.file.exists = true
    h.file.rev = 4
    h.file.todos = [mk({ id: 'file' })]
    const raw = JSON.stringify([mk({ id: 'stale' })])
    h.data.set(TODO_STORAGE_KEY, raw)

    await state().hydrate()

    expect(callsOf('todo_import_legacy')).toHaveLength(0)
    expect(state().todos.map((t) => t.id)).toEqual(['file'])
    // 旧键原封不动（没被删、也没被覆盖）——
    // 读一次是允许的（判定"有没有"），但绝不能改写
    expect(rawStorage()).toBe(raw)
  })

  it('迁移时旧数据损坏：todo-list 原样保留 + corrupt 备份 + 进只读', async () => {
    const broken = '{坏JSON'
    h.data.set(TODO_STORAGE_KEY, broken)

    await state().hydrate()

    // 原文仍在（没删除、没覆盖）
    expect(rawStorage()).toBe(broken)
    // 有且只有一个备份键，内容 = 原文
    const keys = corruptKeys()
    expect(keys).toHaveLength(1)
    expect(h.data.get(keys[0])).toBe(broken)
    // 只读态
    expect(state().corrupt).toBe(true)
    expect(state().todos).toEqual([])
    expect(h.toasts.some((t) => t.message.includes('数据损坏'))).toBe(true)

    // 只读后写操作全部无效
    expect(state().addTodo('新的')).toBeUndefined()
    await flush()
    expect(callsOf('todo_commit')).toHaveLength(0)
    expect(rawStorage()).toBe(broken)
  })
})

// ──────────────────────── 浏览器兜底（无 Tauri IPC） ────────────────────────

describe('浏览器兜底（无 Tauri IPC，localStorage）', () => {
  beforeEach(async () => {
    // 无 IPC → TODO_BACKEND 必须是 browser，否则 QA 环境里整个模块会直接炸
    await loadStore(false)
  })

  it('无 IPC 时走 browser 后端，增删都落 localStorage', async () => {
    expect(backendKind).toBe('browser')
    expect(h.calls).toHaveLength(0)
    await expect(state().dataPath()).resolves.toBe(`localStorage://${TODO_STORAGE_KEY}`)

    await state().hydrate()
    const created = state().addTodo('  买牛奶  ', '2026-03-08')
    await flush()

    expect(created).toBeDefined()
    expect(state().todos).toHaveLength(1)
    // localStorage 里有这条（键仍是 todo-list）
    const stored = storedTodos()
    expect(stored).toHaveLength(1)
    expect(stored[0].text).toBe('买牛奶')
    expect(stored[0].deadline).toBe('2026-03-08')
    expect(typeof stored[0].deadlineTs).toBe('number')

    // 删除同样落盘
    const removed = state().deleteTodo(created!.id)
    await flush()
    expect(removed?.id).toBe(created!.id)
    expect(storedTodos()).toEqual([])
  })

  it('脏语义：读不写盘；中文日期只在内存里规范化', async () => {
    const raw = JSON.stringify([mk({ id: 'a', deadline: '下周三' })])
    h.data.set(TODO_STORAGE_KEY, raw)

    await state().hydrate()

    // 「下周三」解析不了：normalizeTodo 原样返回，磁盘一个字节都没动
    expect(state().todos[0].deadline).toBe('下周三')
    expect(state().todos[0].deadlineTs).toBeUndefined()
    expect(rawStorage()).toBe(raw)

    // 空存储读完仍为空，不创建键
    h.data.clear()
    await loadStore(false)
    await state().hydrate()
    expect(state().todos).toEqual([])
    expect(rawStorage()).toBeNull()
  })

  it('损坏数据：备份原文、不覆盖、只提示一次；之后写操作全部禁用', async () => {
    const broken = '{坏JSON'
    h.data.set(TODO_STORAGE_KEY, broken)

    await state().hydrate()
    // StrictMode 下 effect 会跑两遍：第二次必须完全 no-op
    await state().hydrate()

    expect(rawStorage()).toBe(broken)
    const keys = corruptKeys()
    expect(keys).toHaveLength(1)
    expect(h.data.get(keys[0])).toBe(broken)
    expect(state().todos).toEqual([])
    expect(state().corrupt).toBe(true)
    // 只弹一次
    expect(h.toasts.filter((t) => t.message.includes('数据损坏'))).toHaveLength(1)

    // 只读：原文还躺在那儿等人工抢救，写一次就没了
    expect(state().addTodo('新的')).toBeUndefined()
    await flush()
    expect(rawStorage()).toBe(broken)
  })

  it('跨窗口：storage 事件重读且不写盘；无关键不触发；监听只绑一次', async () => {
    h.data.set(TODO_STORAGE_KEY, JSON.stringify([mk({ id: 'a' })]))
    await state().hydrate()
    // StrictMode / 多个挂载点会反复调 hydrate
    await state().hydrate()
    expect(h.listeners.get('storage')?.size).toBe(1)

    // 另一个窗口（待办窗口）已经落过盘
    const writtenByOtherWindow = JSON.stringify([mk({ id: 'b', text: '另一个窗口写的' })])
    h.data.set(TODO_STORAGE_KEY, writtenByOtherWindow)
    h.fireStorage({ key: TODO_STORAGE_KEY })
    await flush()

    expect(state().todos.map((t) => t.id)).toEqual(['b'])
    // 磁盘上的内容一个字节都没被本实例改写
    expect(rawStorage()).toBe(writtenByOtherWindow)

    // 无关的键不触发重读
    const readsBefore = h.reads.filter((k) => k === TODO_STORAGE_KEY).length
    h.fireStorage({ key: 'infoboard-settings' })
    await flush()
    expect(h.reads.filter((k) => k === TODO_STORAGE_KEY)).toHaveLength(readsBefore)
    expect(state().todos.map((t) => t.id)).toEqual(['b'])

    // e.key === null（另一个窗口 localStorage.clear()）同样当作有效变更重读
    h.data.clear()
    h.fireStorage({ key: null })
    await flush()
    expect(state().todos).toEqual([])
    // 重读路径只读不写：clear 之后存储仍然是空的
    expect(rawStorage()).toBeNull()
  })

  it('另一个窗口写坏数据：不把空列表灌进内存（原文留着等抢救）', async () => {
    h.data.set(TODO_STORAGE_KEY, JSON.stringify([mk({ id: 'a' })]))
    await state().hydrate()

    h.data.set(TODO_STORAGE_KEY, '{坏JSON')
    h.fireStorage({ key: TODO_STORAGE_KEY })
    await flush()

    // 内存里还是原来那批（不是空列表），磁盘原文也没被覆盖
    expect(state().todos.map((t) => t.id)).toEqual(['a'])
    expect(rawStorage()).toBe('{坏JSON')
    expect(state().corrupt).toBe(false)
  })
})
