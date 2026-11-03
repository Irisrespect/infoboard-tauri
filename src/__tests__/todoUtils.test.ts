import { describe, it, expect, vi } from 'vitest'
import {
  chineseDateToIso,
  compareTodosByDeadline,
  getFirstActiveTodo,
  isTodoOverdue,
  loadTodoSnapshot,
  loadTodos,
  nextLocalMidnightDelay,
  normalizeTodo,
  parseDeadlinePatch,
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
    keys: () => [...store.keys()],
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

  /** 回归：原先一律用 now.getFullYear()，12/31 写「1月5日」立刻逾期 359 天 */
  it('中文日期跨年按"下一次出现"规则定年', () => {
    const newYearEve = new Date(2026, 11, 31) // 2026-12-31
    expect(chineseDateToIso('1月5日', newYearEve)).toBe('2027-01-05')
    const ts = parseDeadlineToDayEnd('1月5日', newYearEve)!
    const d = new Date(ts)
    expect([d.getFullYear(), d.getMonth() + 1, d.getDate()]).toEqual([2027, 1, 5])
    expect([d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()]).toEqual([
      23, 59, 59, 999,
    ])
  })

  it('同一天算今年（不跳到明年）', () => {
    const today = new Date(2026, 0, 15) // 2026-01-15
    expect(chineseDateToIso('1月15日', today)).toBe('2026-01-15')
    // 已经是凌晨 0 点也一样算今年
    const justAfterMidnight = new Date(2026, 0, 15, 0, 0, 0, 0)
    expect(chineseDateToIso('1月15日', justAfterMidnight)).toBe('2026-01-15')
  })

  it('ISO 分支不受"下一次出现"规则影响（严格按用户给的年份）', () => {
    const newYearEve = new Date(2026, 11, 31)
    expect(chineseDateToIso('2026-01-05', newYearEve)).toBeNull() // 不是中文格式
    const ts = parseDeadlineToDayEnd('2026-01-05', newYearEve)!
    const d = new Date(ts)
    expect([d.getFullYear(), d.getMonth() + 1, d.getDate()]).toEqual([2026, 1, 5])
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

  it('已完成项沉底（优先于截止时间）', () => {
    const list = [
      mk({ id: 'done-early', completed: true, deadlineTs: 100 }),
      mk({ id: 'active-late', deadlineTs: 900 }),
      mk({ id: 'done-no-deadline', completed: true, createdAt: 500 }),
      mk({ id: 'active-no-deadline', createdAt: 10 }),
      mk({ id: 'active-early', deadlineTs: 200 }),
    ]
    expect([...list].sort(compareTodosByDeadline).map((t) => t.id)).toEqual([
      'active-early',
      'active-late',
      'active-no-deadline',
      'done-early',
      'done-no-deadline',
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

  /** 比较器加了"已完成沉底"后，先 filter 再排序的预览逻辑必须仍然正确 */
  it('getFirstActiveTodo 不受已完成项沉底影响', () => {
    const list = [
      mk({ id: 'done-first', completed: true, deadlineTs: 1 }),
      mk({ id: 'done-second', completed: true, deadlineTs: 2 }),
      mk({ id: 'active', createdAt: 1 }),
    ]
    expect(getFirstActiveTodo(list)?.id).toBe('active')
  })
})

describe('逾期待办判定', () => {
  const dayEnd = new Date(2026, 0, 15, 23, 59, 59, 999).getTime()
  const nextMidnight = new Date(2026, 0, 16, 0, 0, 0, 0).getTime()

  it('截止当天 23:59:59.999 不逾期，次日 0 点起逾期', () => {
    const todo = mk({ deadlineTs: dayEnd })
    expect(isTodoOverdue(todo, dayEnd)).toBe(false)
    // 23:59:59.999 再过 1ms 就是次日 0 点，从此逾期
    expect(dayEnd + 1).toBe(nextMidnight)
    expect(isTodoOverdue(todo, nextMidnight)).toBe(true)
  })

  it('已完成项永不逾期', () => {
    expect(isTodoOverdue(mk({ completed: true, deadlineTs: dayEnd }), nextMidnight)).toBe(false)
  })

  it('没有截止时间不逾期', () => {
    expect(isTodoOverdue(mk({}), nextMidnight)).toBe(false)
  })
})

describe('跨天延时', () => {
  it('nextLocalMidnightDelay 恒 > 0 且 <= 24h + 1s', () => {
    const samples = [
      new Date(2026, 0, 15, 0, 0, 0, 0), // 正好 0 点
      new Date(2026, 0, 15, 12, 34, 56, 789),
      new Date(2026, 0, 15, 23, 59, 59, 999),
      new Date(2026, 5, 30), // 半年闰日之后
      new Date(2026, 11, 31, 23, 0, 0, 0), // 跨年
    ]
    const max = 24 * 60 * 60 * 1000 + 1000
    for (const now of samples) {
      const delay = nextLocalMidnightDelay(now)
      expect(delay).toBeGreaterThan(0)
      expect(delay).toBeLessThanOrEqual(max)
      // 触发时刻必须已经翻到本地次日 0 点之后（多出的 1 秒是缓冲）
      const fireAt = new Date(now.getTime() + delay)
      expect(
        fireAt.getTime() > new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime()
      ).toBe(true)
    }
  })
})

describe('旧数据迁移 normalizeTodo', () => {
  const now = new Date(2026, 0, 15)

  it('ISO 原文保留，只补 deadlineTs', () => {
    const out = normalizeTodo(mk({ deadline: '2026-03-08' }), now)
    expect(out.deadline).toBe('2026-03-08')
    expect(new Date(out.deadlineTs!).getDate()).toBe(8)
  })

  it('中文格式转成 ISO', () => {
    const out = normalizeTodo(mk({ deadline: '3月8日' }), now)
    expect(out.deadline).toBe('2026-03-08')
    expect(out.deadlineTs).toBe(parseDeadlineToDayEnd('3月8日', now))
  })

  /** 回归：原先解析失败会 { deadline: undefined }，把用户原文永久删掉 */
  it('无法解析的原文（如"下周三"）原样保留，不删 deadline、不补 deadlineTs', () => {
    const input = mk({ id: 'keep', deadline: '下周三' })
    const out = normalizeTodo(input, now)
    expect(out).toBe(input) // 原样返回，未生成清空过的副本
    expect(out.deadline).toBe('下周三')
    expect(out.deadlineTs).toBeUndefined()
  })

  it('日期不存在时同样保留原文（不替用户改日期）', () => {
    const out = normalizeTodo(mk({ deadline: '2月30日' }), now)
    expect(out.deadline).toBe('2月30日')
    expect(out.deadlineTs).toBeUndefined()
  })

  it('已有 deadlineTs 的旧数据不动', () => {
    const input = mk({ deadline: '下周三', deadlineTs: 123 })
    expect(normalizeTodo(input, now)).toBe(input)
  })
})

describe('编辑 deadline 的解析 parseDeadlinePatch', () => {
  const now = new Date(2026, 0, 15)

  it('可解析 → 同时给出原文与 deadlineTs（中文转 ISO）', () => {
    expect(parseDeadlinePatch('3月8日', now)).toEqual({
      deadline: '2026-03-08',
      deadlineTs: parseDeadlineToDayEnd('3月8日', now),
    })
  })

  it('空白 → 明确清空', () => {
    expect(parseDeadlinePatch('   ', now)).toEqual({ deadline: undefined, deadlineTs: undefined })
    expect(parseDeadlinePatch(undefined, now)).toEqual({
      deadline: undefined,
      deadlineTs: undefined,
    })
  })

  it('无法解析 → null（调用方据此忽略这次修改）', () => {
    expect(parseDeadlinePatch('下周三', now)).toBeNull()
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

  it('loadTodoSnapshot 区分三种状态', () => {
    // 键不存在 → empty
    expect(loadTodoSnapshot(fakeStorage())).toEqual({ todos: [], status: 'empty' })

    // 非法 JSON / 非数组 → corrupt
    expect(loadTodoSnapshot(fakeStorage('{不是 JSON')).status).toBe('corrupt')
    expect(loadTodoSnapshot(fakeStorage('{不是 JSON')).todos).toEqual([])
    expect(loadTodoSnapshot(fakeStorage('{"a":1}')).status).toBe('corrupt')
    expect(loadTodoSnapshot(fakeStorage('null')).status).toBe('corrupt')

    // 正常 → ok，且数据原样读出
    const s = fakeStorage()
    saveTodos([mk({ id: 'ok', text: '正常' })], s)
    expect(loadTodoSnapshot(s)).toEqual({
      todos: [mk({ id: 'ok', text: '正常' })],
      status: 'ok',
    })
  })

  it('loadTodos 是薄包装：正常数据原样读出、坏数据回退空数组', () => {
    const s = fakeStorage()
    saveTodos([mk({ id: 'a' })], s)
    // 具体 literal：不拿"另一个函数解析同一份数据的结果"跟自己对表（那种断言几乎恒真）
    expect(loadTodos(s)).toEqual([{ id: 'a', text: 't', completed: false, createdAt: 0 }])
    expect(loadTodos(fakeStorage('坏数据'))).toEqual([])
    expect(loadTodoSnapshot(fakeStorage()).status).toBe('empty')
  })

  /** 损坏时必须留着原文给上层备份，不能只回空数组 */
  it('corrupt 时原始字符串仍可从 storage 读到（供备份）', () => {
    const s = fakeStorage('{坏的原始数据')
    expect(loadTodoSnapshot(s).status).toBe('corrupt')
    expect(s.raw()).toBe('{坏的原始数据')
  })
})
