/**
 * 待办数据层（模块级单一数据源）单测
 *
 * node 环境没有 localStorage，也没有 window：假 storage / 假 toast 都必须在 import
 * 之前装好（vi.hoisted 先于所有 import 执行）。store 自己也刻意不在模块顶层读盘，
 * 所以"先打桩、后 import"的顺序能成立。
 *
 * 隔离方式：每个用例 `vi.resetModules()` 后重新 import store —— 这样模块级的
 * `hydrated` / `backedUp` 闩锁和 store 状态都回到初始值（单个 store 实例的闩锁
 * 一旦置位就无法用 setState 复位）。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Todo } from '../plugins/todo/types'
import { TODO_CORRUPT_KEY_PREFIX, TODO_STORAGE_KEY } from '../plugins/todo/utils'

const h = vi.hoisted(() => {
  const data = new Map<string, string>()
  /** 每次 getItem 的键名（用来验证"只读一次盘"） */
  const reads: string[] = []
  /** toastAPI.show 的入参（用来验证"只弹一次"） */
  const toasts: Array<{ message: string; color?: string }> = []
  /** window.addEventListener 注册的监听器（按事件名），用来模拟"另一个窗口"改了数据 */
  const listeners = new Map<string, Set<(event: unknown) => void>>()
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

  g.window = {
    toastAPI: {
      show: (payload: { message: string; color?: string }) => {
        toasts.push(payload)
      },
    },
    // store 的 storage 监听注册在这上面（`canListenStorage()` 要求它是函数）
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      const set = listeners.get(type) ?? new Set<(event: unknown) => void>()
      set.add(handler)
      listeners.set(type, set)
    },
    removeEventListener: (type: string, handler: (event: unknown) => void) => {
      listeners.get(type)?.delete(handler)
    },
  }

  /**
   * 模拟浏览器在**另一个窗口**写盘后派发的 storage 事件
   *
   * 真实浏览器只在"同源的其他窗口"派发，写方自己收不到 —— 测试里手动触发，
   * 语义正好对应"待办窗口改了数据，主窗口的 store 该重读"。
   */
  const fireStorage = (event: { key: string | null }) => {
    for (const handler of listeners.get('storage') ?? []) handler(event)
  }

  return { data, reads, toasts, listeners, fireStorage }
})

type StoreModule = typeof import('../plugins/todo/store')
let useTodoStore: StoreModule['useTodoStore']

/** 取当前 store 状态（单测里只关心快照） */
function state() {
  return useTodoStore.getState()
}

/** 磁盘上 todo-list 的原始字符串 */
function rawStorage(): string | null {
  return h.data.get(TODO_STORAGE_KEY) ?? null
}

/** 磁盘上 todo-list 解析后的数组 */
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

beforeEach(async () => {
  h.data.clear()
  h.reads.length = 0
  h.toasts.length = 0
  // 上一个用例的模块实例已经作废（resetModules），它注册的监听器也必须丢掉，
  // 否则第二次 fireStorage 会把两个实例的回调都跑一遍
  h.listeners.clear()
  vi.resetModules()
  const mod: StoreModule = await import('../plugins/todo/store')
  useTodoStore = mod.useTodoStore
})

describe('hydrate 幂等', () => {
  it('只读一次盘：重复调用不会把磁盘内容重新灌回内存', () => {
    h.data.set(TODO_STORAGE_KEY, JSON.stringify([mk({ id: 'a', text: '磁盘上的' })]))

    state().hydrate()
    expect(state().todos.map((t) => t.id)).toEqual(['a'])
    expect(h.reads.filter((k) => k === TODO_STORAGE_KEY)).toHaveLength(1)

    // 磁盘被外部改动（另一个窗口 / 手工改文件）：第二次 hydrate 必须是 no-op
    h.data.set(TODO_STORAGE_KEY, JSON.stringify([]))
    state().hydrate()

    expect(state().todos.map((t) => t.id)).toEqual(['a'])
    expect(h.reads.filter((k) => k === TODO_STORAGE_KEY)).toHaveLength(1)
  })

  it('没发生用户操作就不写盘（脏语义）：空 localStorage 读完仍为空', () => {
    state().hydrate()
    expect(state().todos).toEqual([])
    expect(rawStorage()).toBeNull()
  })

  it('读到旧数据只做迁移，不改写原文（脏语义）', () => {
    const raw = JSON.stringify([mk({ id: 'a', deadline: '下周三' })])
    h.data.set(TODO_STORAGE_KEY, raw)

    state().hydrate()

    // 「下周三」解析不了：normalizeTodo 原样返回，磁盘一个字节都没动
    expect(state().todos[0].deadline).toBe('下周三')
    expect(state().todos[0].deadlineTs).toBeUndefined()
    expect(rawStorage()).toBe(raw)
  })
})

describe('addTodo', () => {
  it('新增后写盘，并能从磁盘读回', () => {
    state().hydrate()
    const created = state().addTodo('  买牛奶  ', '2026-03-08')

    expect(created).toBeDefined()
    expect(created!.text).toBe('买牛奶')
    expect(state().todos).toHaveLength(1)
    expect(state().todos[0].id).toBe(created!.id)

    // 磁盘里有这条（同步写，不等 effect）
    const stored = storedTodos()
    expect(stored).toHaveLength(1)
    expect(stored[0].text).toBe('买牛奶')
    expect(stored[0].deadline).toBe('2026-03-08')
    expect(typeof stored[0].deadlineTs).toBe('number')
  })

  it('空文本不新增、不写盘', () => {
    state().hydrate()
    expect(state().addTodo('   ')).toBeUndefined()
    expect(state().addTodo('')).toBeUndefined()
    expect(state().todos).toEqual([])
    expect(rawStorage()).toBeNull()
  })

  it('非法日期：不写入该截止时间（待办本身保留）', () => {
    state().hydrate()
    // 2026-02-30 不存在：utils 拒绝解析（不会悄悄进位成 3 月 2 日）
    const created = state().addTodo('开会', '2026-02-30')

    expect(created).toBeDefined()
    expect(created!.deadline).toBeUndefined()
    expect(created!.deadlineTs).toBeUndefined()
    expect(storedTodos()[0].deadline).toBeUndefined()
    expect(h.toasts.some((t) => t.message.includes('截止日期无效'))).toBe(true)
  })
})

describe('deleteTodo / restoreTodo', () => {
  it('同步返回被删项，列表少一条，且写盘', () => {
    h.data.set(TODO_STORAGE_KEY, JSON.stringify([mk({ id: 'a' }), mk({ id: 'b' })]))
    state().hydrate()

    const removed = state().deleteTodo('a')

    expect(removed?.id).toBe('a')
    expect(state().todos.map((t) => t.id)).toEqual(['b'])
    expect(storedTodos().map((t) => t.id)).toEqual(['b'])
    // 删不存在的 id：返回 undefined，不新增
    expect(state().deleteTodo('nope')).toBeUndefined()
  })

  it('撤销能恢复，且同 id 插两次仍只有一条', () => {
    h.data.set(TODO_STORAGE_KEY, JSON.stringify([mk({ id: 'a', text: '甲' }), mk({ id: 'b' })]))
    state().hydrate()

    const removed = state().deleteTodo('a')!
    state().restoreTodo(removed)
    expect(
      state()
        .todos.map((t) => t.id)
        .sort()
    ).toEqual(['a', 'b'])

    // 同一条再撤销一次：不能重复插入
    state().restoreTodo(removed)
    expect(state().todos.filter((t) => t.id === 'a')).toHaveLength(1)
    expect(state().todos).toHaveLength(2)
    expect(storedTodos()).toHaveLength(2)
  })
})

describe('clearCompleted / restoreTodos', () => {
  it('同步返回被清列表，撤销能整批恢复（按 id 去重）', () => {
    h.data.set(
      TODO_STORAGE_KEY,
      JSON.stringify([
        mk({ id: 'a', completed: true }),
        mk({ id: 'b', completed: false }),
        mk({ id: 'c', completed: true }),
      ])
    )
    state().hydrate()

    const removed = state().clearCompleted()
    expect(removed.map((t) => t.id).sort()).toEqual(['a', 'c'])
    expect(state().todos.map((t) => t.id)).toEqual(['b'])
    expect(storedTodos().map((t) => t.id)).toEqual(['b'])

    state().restoreTodos(removed)
    expect(
      state()
        .todos.map((t) => t.id)
        .sort()
    ).toEqual(['a', 'b', 'c'])
    expect(storedTodos()).toHaveLength(3)

    // 再撤销一次：已存在的 id 全部跳过，不重复插入
    state().restoreTodos(removed)
    expect(state().todos).toHaveLength(3)
  })

  it('空数组 / 全部已存在时不写盘', () => {
    h.data.set(TODO_STORAGE_KEY, JSON.stringify([mk({ id: 'a' })]))
    state().hydrate()
    const before = rawStorage()

    state().restoreTodos([])
    state().restoreTodos([mk({ id: 'a' })])

    expect(state().todos).toHaveLength(1)
    expect(rawStorage()).toBe(before)
  })
})

describe('损坏数据保护', () => {
  it('hydrate 备份原始字符串、不覆盖原文、只备份/只提示一次', () => {
    const broken = '{坏JSON'
    h.data.set(TODO_STORAGE_KEY, broken)

    state().hydrate()
    // StrictMode 下 effect 会跑两遍：第二次必须完全 no-op
    state().hydrate()

    // 原始字符串仍在（没有被空列表覆盖）
    expect(rawStorage()).toBe(broken)
    // 有且只有一个备份键，且备份内容 = 原文
    const keys = corruptKeys()
    expect(keys).toHaveLength(1)
    expect(h.data.get(keys[0])).toBe(broken)
    // 内存里是空列表（可抢救的原文没被当成数据用）
    expect(state().todos).toEqual([])
    // 只弹一次
    const corruptToasts = h.toasts.filter((t) => t.message.includes('数据损坏'))
    expect(corruptToasts).toHaveLength(1)
  })

  it('损坏后用户新增待办：原备份还在，todo-list 才被正常数据覆盖', () => {
    h.data.set(TODO_STORAGE_KEY, '[not-json')
    state().hydrate()
    const backupKey = corruptKeys()[0]

    state().addTodo('新的')

    expect(h.data.get(backupKey)).toBe('[not-json')
    expect(storedTodos().map((t) => t.text)).toEqual(['新的'])
  })
})

/**
 * 跨窗口同步
 *
 * 待办的详细管理已经是**独立窗口**（`#/todo`），和主窗口同源、读写同一份 `todo-list`。
 * 之前那套 `todo:data-changed` 自定义事件是给"同窗口两个模块实例"用的，已经删掉；
 * 现在靠浏览器原生派发的 `storage` 事件 —— 所以这里断言的是"监听到了就重读，且绝不写盘"。
 */
describe('跨窗口同步（storage 事件）', () => {
  it('hydrate 懒注册 storage 监听，且只绑一次', () => {
    h.data.set(TODO_STORAGE_KEY, JSON.stringify([mk({ id: 'a' })]))
    state().hydrate()
    // StrictMode / 多个挂载点会反复调 hydrate
    state().hydrate()
    expect(h.listeners.get('storage')?.size).toBe(1)
  })

  it('另一个窗口改完数据：重读进内存，且不写盘（写回去就是回声覆盖）', () => {
    h.data.set(TODO_STORAGE_KEY, JSON.stringify([mk({ id: 'a' })]))
    state().hydrate()

    // 另一个窗口（待办窗口）已经落过盘
    const writtenByOtherWindow = JSON.stringify([mk({ id: 'b', text: '另一个窗口写的' })])
    h.data.set(TODO_STORAGE_KEY, writtenByOtherWindow)
    h.fireStorage({ key: TODO_STORAGE_KEY })

    expect(state().todos.map((t) => t.id)).toEqual(['b'])
    // 磁盘上的内容一个字节都没被本实例改写
    expect(rawStorage()).toBe(writtenByOtherWindow)
  })

  it('e.key === null（另一个窗口 localStorage.clear()）同样当作有效变更重读', () => {
    h.data.set(TODO_STORAGE_KEY, JSON.stringify([mk({ id: 'a' })]))
    state().hydrate()

    h.data.clear()
    h.fireStorage({ key: null })

    expect(state().todos).toEqual([])
    // 重读路径只读不写：clear 之后磁盘仍然是空的
    expect(rawStorage()).toBeNull()
  })

  it('无关的键不触发重读', () => {
    h.data.set(TODO_STORAGE_KEY, JSON.stringify([mk({ id: 'a' })]))
    state().hydrate()
    h.data.set(TODO_STORAGE_KEY, JSON.stringify([mk({ id: 'b' })]))
    const readsBefore = h.reads.filter((k) => k === TODO_STORAGE_KEY).length

    h.fireStorage({ key: 'infoboard-settings' })

    expect(h.reads.filter((k) => k === TODO_STORAGE_KEY)).toHaveLength(readsBefore)
    expect(state().todos.map((t) => t.id)).toEqual(['a'])
  })

  it('磁盘上是损坏数据：不把空列表灌进内存（保持只读语义，原文留着等抢救）', () => {
    h.data.set(TODO_STORAGE_KEY, JSON.stringify([mk({ id: 'a' })]))
    state().hydrate()

    h.data.set(TODO_STORAGE_KEY, '{坏JSON')
    h.fireStorage({ key: TODO_STORAGE_KEY })

    // 内存里还是原来那批（不是空列表），磁盘原文也没被覆盖
    expect(state().todos.map((t) => t.id)).toEqual(['a'])
    expect(rawStorage()).toBe('{坏JSON')
  })

  it('另一个窗口写入的中文日期会走一次 normalizeTodo（中文转 ISO）', () => {
    state().hydrate()
    h.data.set(TODO_STORAGE_KEY, JSON.stringify([mk({ id: 'a', deadline: '3月8日' })]))
    h.fireStorage({ key: TODO_STORAGE_KEY })

    const [todo] = state().todos
    expect(/^\d{4}-\d{2}-\d{2}$/.test(todo.deadline ?? '')).toBe(true)
    expect(typeof todo.deadlineTs).toBe('number')
    // 迁移只在内存里做，不产生写盘
    expect(storedTodos()[0].deadline).toBe('3月8日')
  })
})
