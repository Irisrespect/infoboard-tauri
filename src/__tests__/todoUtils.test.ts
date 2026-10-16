import { describe, it, expect, vi } from 'vitest'
import {
  chineseDateToIso,
  compareTodosByDeadline,
  getFirstActiveTodo,
  loadTodos,
  parseDeadlineToDayEnd,
  saveTodos,
  TODO_STORAGE_KEY,
} from '../plugins/todo/utils'
import type { Todo } from '../plugins/todo/types'

/** 用 Map 伪造 localStorage */
function fakeStorage(initial?: string) {
  const store = new Map<string, string>()
  if (initial !== undefined) store.set(TODO_STORAGE_KEY, initial)
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    raw: () => store.get(TODO_STORAGE_KEY),
  }
}

function mk(partial: Partial<Todo>): Todo {
  return {
    id: 'x',
    text: 't',
    completed: false,
    createdAt: 0,
    ...partial,
  }
}

describe('待办截止日期解析', () => {
  const now = new Date(2026, 0, 15) // 2026-01-15

  it('合法 ISO 日期 → 当天 23:59:59.999（本地时区）', () => {
    const ts = parseDeadlineToDayEnd('2026-03-08', now)
    expect(ts).toBeDefined()
    const d = new Date(ts!)
    expect([d.getFullYear(), d.getMonth() + 1, d.getDate()]).toEqual([2026, 3, 8])
    expect([d.getHours(), d.getMinutes(), d.getSeconds()]).toEqual([23, 59, 59])
  })

  /** 回归：2026-02-30 原先被 JS 自动进位成 2026-03-02 */
  it('不存在的日期被拒绝，而不是进位成别的日期', () => {
    expect(parseDeadlineToDayEnd('2026-02-30', now)).toBeUndefined()
    expect(parseDeadlineToDayEnd('2026-13-01', now)).toBeUndefined()
    expect(parseDeadlineToDayEnd('2026-04-31', now)).toBeUndefined()
    expect(parseDeadlineToDayEnd('2026-00-10', now)).toBeUndefined()
    // 闰年 2 月 29 日有效，平年无效
    expect(parseDeadlineToDayEnd('2028-02-29', now)).toBeDefined()
    expect(parseDeadlineToDayEnd('2026-02-29', now)).toBeUndefined()
  })

  it('中文格式按当年解析，非法日期同样拒绝', () => {
    expect(chineseDateToIso('3月8日', now)).toBe('2026-03-08')
    expect(chineseDateToIso('2月30日', now)).toBeNull()
    expect(parseDeadlineToDayEnd('3月8日', now)).toBeDefined()
    expect(parseDeadlineToDayEnd('2月30日', now)).toBeUndefined()
  })

  it('无法识别的写法 / 空串 → undefined', () => {
    for (const bad of ['', '   ', '明天', '2026/03/08', '03-08', '2026-3-8']) {
      expect(parseDeadlineToDayEnd(bad, now)).toBeUndefined()
    }
  })
})

describe('待办排序', () => {
  it('有截止时间的在前（升序），无截止时间的按创建时间倒序在后', () => {
    const list = [
      mk({ id: 'no-deadline-old', createdAt: 100 }),
      mk({ id: 'late', deadlineTs: 2000 }),
      mk({ id: 'no-deadline-new', createdAt: 300 }),
      mk({ id: 'early', deadlineTs: 1000 }),
    ]
    expect([...list].sort(compareTodosByDeadline).map((t) => t.id)).toEqual([
      'early',
      'late',
      'no-deadline-new',
      'no-deadline-old',
    ])
  })

  it('getFirstActiveTodo 取最早截止的未完成项', () => {
    const list = [
      mk({ id: 'done', completed: true, deadlineTs: 1 }),
      mk({ id: 'later', deadlineTs: 500 }),
      mk({ id: 'soon', deadlineTs: 100 }),
    ]
    expect(getFirstActiveTodo(list)?.id).toBe('soon')
    expect(getFirstActiveTodo([mk({ id: 'a', completed: true })])).toBeUndefined()
  })
})

describe('待办存储', () => {
  it('读回写入的内容', () => {
    const s = fakeStorage()
    expect(saveTodos([mk({ id: 'a', text: '写测试' })], s)).toBe(true)
    expect(loadTodos(s).map((t) => t.text)).toEqual(['写测试'])
  })

  it('脏数据回退为空列表、不抛错', () => {
    expect(loadTodos(fakeStorage('{不是 JSON'))).toEqual([])
    expect(loadTodos(fakeStorage('{"a":1}'))).toEqual([])
    expect(loadTodos(fakeStorage())).toEqual([])
  })

  /** 回归：写盘失败原先只 console.warn，用户以为已保存 */
  it('写盘失败返回 false（调用方据此提示用户）', () => {
    const failing = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('QuotaExceededError')
      },
    }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(saveTodos([mk({})], failing)).toBe(false)
    spy.mockRestore()
  })
})
