/**
 * 待办工具函数
 *
 * 提取共享的排序、日期解析和存储逻辑，避免重复代码
 */

import type { Todo } from './types'

/**
 * 按截止时间排序比较函数
 *
 * 排序规则：
 * 1. 有截止时间的排前面（按时间升序）
 * 2. 无截止时间的排后面（按创建时间降序）
 */
export function compareTodosByDeadline(a: Todo, b: Todo): number {
  const aHas = a.deadlineTs != null
  const bHas = b.deadlineTs != null
  if (aHas && bHas) return a.deadlineTs! - b.deadlineTs!
  if (aHas) return -1
  if (bHas) return 1
  return b.createdAt - a.createdAt
}

/**
 * 获取第一条未完成的待办（用于折叠态预览）
 *
 * @param todos - 所有待办列表
 * @returns 第一条未完成的待办，如果没有则返回 undefined
 */
export function getFirstActiveTodo(todos: Todo[]): Todo | undefined {
  const activeTodos = todos.filter((t) => !t.completed)
  if (activeTodos.length === 0) {
    return undefined
  }
  return [...activeTodos].sort(compareTodosByDeadline)[0]
}

/**
 * ISO 日期格式正则表达式（带捕获组：年 / 月 / 日）
 */
export const ISO_DATE_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/

/** 中文日期格式（M月D日） */
export const CN_DATE_REGEX = /^(\d{1,2})月(\d{1,2})日$/

/**
 * 构造本地时区"当天 23:59:59.999"的时间戳。
 *
 * 必须做往返校验：`new Date(2026, 1, 30)` 不会报错，而是**自动进位**成 3 月 2 日，
 * 于是用户填的 `2026-02-30` 会被悄悄改成 `2026-03-02`。取回年月日不一致就返回
 * undefined（当作"没有有效截止时间"），而不是替用户改日期。
 */
function makeLocalDayEnd(year: number, month: number, day: number): number | undefined {
  const date = new Date(year, month - 1, day, 23, 59, 59, 999)
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    Number.isNaN(date.getTime())
  ) {
    return undefined
  }
  return date.getTime()
}

/** "6月20日" → "2026-06-20"（按给定年份）；无法解析返回 null */
export function chineseDateToIso(text: string, now: Date = new Date()): string | null {
  const match = CN_DATE_REGEX.exec(text.trim())
  if (!match) return null
  const month = Number(match[1])
  const day = Number(match[2])
  if (makeLocalDayEnd(now.getFullYear(), month, day) === undefined) return null
  return `${now.getFullYear()}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/**
 * 将截止日期字符串转换为本地时区当天结束时间（23:59:59.999）
 *
 * 支持 `YYYY-MM-DD` 和 `M月D日`；日期不存在（如 2026-02-30、2月30日）时返回 undefined。
 */
export function parseDeadlineToDayEnd(
  deadline: string,
  now: Date = new Date()
): number | undefined {
  const text = deadline.trim()
  if (!text) return undefined

  const iso = ISO_DATE_REGEX.exec(text)
  if (iso) {
    return makeLocalDayEnd(Number(iso[1]), Number(iso[2]), Number(iso[3]))
  }

  const cn = CN_DATE_REGEX.exec(text)
  if (cn) {
    return makeLocalDayEnd(now.getFullYear(), Number(cn[1]), Number(cn[2]))
  }

  return undefined
}

/** localStorage 键名（待办列表） */
export const TODO_STORAGE_KEY = 'todo-list'

type StorageLike = {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

/**
 * 从 localStorage 读取待办（脏数据一律回退为空列表）
 *
 * @param storage 可注入，便于测试；默认用全局 localStorage
 */
export function loadTodos(storage: StorageLike = localStorage): Todo[] {
  try {
    const stored = storage.getItem(TODO_STORAGE_KEY)
    if (!stored) return []
    const parsed: unknown = JSON.parse(stored)
    return Array.isArray(parsed) ? (parsed as Todo[]) : []
  } catch {
    return []
  }
}

/**
 * 保存待办到 localStorage
 *
 * @returns 是否保存成功。**调用方必须处理 false**：写盘失败（配额满 / 隐私模式）
 *          时静默吞掉会让用户以为改动已保存，实际丢数据。
 */
export function saveTodos(todos: Todo[], storage: StorageLike = localStorage): boolean {
  try {
    storage.setItem(TODO_STORAGE_KEY, JSON.stringify(todos))
    return true
  } catch (err) {
    console.error('[待办插件] 保存失败:', err)
    return false
  }
}

