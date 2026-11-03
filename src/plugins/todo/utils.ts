/**
 * 待办工具函数
 *
 * 提取共享的排序、日期解析、旧数据迁移与存储逻辑，避免重复代码。
 * 所有与"当前时间"相关的函数都接受可选的 `now` 参数，便于单测注入固定时间。
 */

import type { Todo } from './types'

/**
 * 按截止时间排序比较函数
 *
 * 排序规则：
 * 1. 未完成在前，已完成沉底（勾掉一条就沉到底部，不再占住第一条预览）
 * 2. 组内：有截止时间的排前面（按时间升序），无截止时间的排后面（按创建时间降序）
 */
export function compareTodosByDeadline(a: Todo, b: Todo): number {
  if (a.completed !== b.completed) return a.completed ? 1 : -1
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
 * 注意：这里先 filter 未完成再排序，所以比较器新增的"已完成沉底"不影响结果。
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

/** 本地"今天 00:00:00.000"的时间戳 */
function localTodayStart(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
}

/**
 * 中文日期该落在哪一年 —— "下一次出现"规则。
 *
 * 候选年份先取今年：构造 `Y-M-D 23:59:59.999`，若该时刻早于"今天 00:00"
 * 说明今年这一天已经过去了，改用 `Y+1`。这样 12 月 31 日写「1月5日」得到的是
 * 明年的 1 月 5 日，而不是一个已经逾期 359 天的日期；同一天算今年。
 *
 * ISO `YYYY-MM-DD` 分支不走这里（严格按用户给的年份）。
 */
function resolveChineseDateYear(month: number, day: number, now: Date): number {
  const year = now.getFullYear()
  const endOfThisYear = new Date(year, month - 1, day, 23, 59, 59, 999).getTime()
  if (Number.isNaN(endOfThisYear)) return year
  return endOfThisYear < localTodayStart(now) ? year + 1 : year
}

/**
 * 把中文日期解析成 `{ year, ts }`（年份按"下一次出现"规则）。
 * 日期不存在（如 2月30日、平年 2月29日）返回 null。
 */
function resolveChineseDate(
  month: number,
  day: number,
  now: Date
): { year: number; ts: number } | null {
  const year = resolveChineseDateYear(month, day, now)
  const ts = makeLocalDayEnd(year, month, day)
  if (ts === undefined) return null
  return { year, ts }
}

/** 提取中文日期的月 / 日；不匹配返回 null */
function cnDateParts(text: string): { month: number; day: number } | null {
  const match = CN_DATE_REGEX.exec(text)
  if (!match) return null
  return { month: Number(match[1]), day: Number(match[2]) }
}

/** "6月20日" → "2026-06-20"（按"下一次出现"规则定年）；无法解析返回 null */
export function chineseDateToIso(text: string, now: Date = new Date()): string | null {
  const parts = cnDateParts(text.trim())
  if (!parts) return null
  const resolved = resolveChineseDate(parts.month, parts.day, now)
  if (!resolved) return null
  return `${resolved.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
}

/**
 * 将截止日期字符串转换为本地时区当天结束时间（23:59:59.999）
 *
 * 支持 `YYYY-MM-DD`（严格按给定年份）和 `M月D日`（按"下一次出现"规则定年）；
 * 日期不存在（如 2026-02-30、2月30日）时返回 undefined。
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

  const parts = cnDateParts(text)
  if (parts) {
    const resolved = resolveChineseDate(parts.month, parts.day, now)
    return resolved ? resolved.ts : undefined
  }

  return undefined
}

/**
 * 是否逾期：未完成 + 有截止时间戳 + 截止时刻已经过去
 *
 * 截止时间存的是"当天 23:59:59.999"，所以当天不会算逾期；跨过 0 点才逾期。
 *
 * @param nowTs 可注入，便于测试；默认取当前时间
 */
export function isTodoOverdue(todo: Todo, nowTs: number = Date.now()): boolean {
  if (todo.completed) return false
  if (todo.deadlineTs == null) return false
  return todo.deadlineTs < nowTs
}

/**
 * 迁移旧版截止时间数据
 *
 * - "YYYY-MM-DD" 格式 → 计算 deadlineTs（当天结束时间）
 * - "6月20日" 格式 → 解析为"下一次出现"的日期，转 ISO + deadlineTs
 * - 无法解析（如"下周三"）→ **原样返回**，保留用户原文，绝不静默清空
 *
 * 解析失败时清空 deadline 会让用户手写的日期永久消失（且挂载首帧就落盘），
 * 所以这里只做"能确定的迁移"，其余一律不动。
 */
export function normalizeTodo(todo: Todo, now: Date = new Date()): Todo {
  if (!todo.deadline || todo.deadlineTs) return todo

  const ts = parseDeadlineToDayEnd(todo.deadline, now)
  if (ts === undefined) return todo

  const text = todo.deadline.trim()
  if (CN_DATE_REGEX.test(text)) {
    const iso = chineseDateToIso(text, now)
    return { ...todo, deadline: iso ?? todo.deadline, deadlineTs: ts }
  }
  return { ...todo, deadlineTs: ts }
}

/** 规范化后的截止时间字段（deadline 原文 + 派生的 deadlineTs） */
export interface DeadlinePatch {
  deadline: string | undefined
  deadlineTs: number | undefined
}

/**
 * 解析 `updateTodo` 传进来的 deadline 修改
 *
 * - 空白串 / null / undefined → 明确清空截止时间
 * - 可解析 → 规范化后返回（中文日期转 ISO，与 normalizeTodo 保持一致）
 * - 不可解析（如"下周三"）→ 返回 null，调用方据此**忽略这次 deadline 修改**，
 *   而不是把用户原文抹掉
 */
export function parseDeadlinePatch(
  deadline: string | null | undefined,
  now: Date = new Date()
): DeadlinePatch | null {
  const text = deadline?.trim() ?? ''
  if (!text) return { deadline: undefined, deadlineTs: undefined }

  const deadlineTs = parseDeadlineToDayEnd(text, now)
  if (deadlineTs === undefined) return null

  if (CN_DATE_REGEX.test(text)) {
    return { deadline: chineseDateToIso(text, now) ?? text, deadlineTs }
  }
  return { deadline: text, deadlineTs }
}

/**
 * 距"下一个本地 0 点 + 1 秒"的毫秒数（用作 setTimeout 延时）
 *
 * 多出的 1 秒是缓冲：确保定时器触发时本地日期已经翻页，重算逾期/跨天才不会
 * 卡在旧的一天上。返回值恒 > 0 且 <= 24h + 1s。
 */
export function nextLocalMidnightDelay(now: Date = new Date()): number {
  const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0)
  const delay = nextMidnight.getTime() - now.getTime() + 1000
  // 夏令时前后一天可能不是 24h；非正数说明时钟异常，兜底 1 秒避免死循环
  return delay > 0 ? delay : 1000
}

/** localStorage 键名（待办列表） */
export const TODO_STORAGE_KEY = 'todo-list'

/** 损坏数据备份键名前缀（后面接时间戳） */
export const TODO_CORRUPT_KEY_PREFIX = `${TODO_STORAGE_KEY}.corrupt.`

type StorageLike = {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

/** 读取结果：区分"没有数据"和"数据坏了"，避免把可抢救的原文当空列表覆盖掉 */
export interface TodoSnapshot {
  todos: Todo[]
  status: 'ok' | 'empty' | 'corrupt'
}

/**
 * 从 localStorage 读取待办，并报告数据状态
 *
 * - 键不存在 → `empty`
 * - 解析失败 / 不是数组 → `corrupt`（`todos: []`，但调用方必须保留原始字符串）
 * - 成功 → `ok`
 *
 * @param storage 可注入，便于测试；默认用全局 localStorage
 */
export function loadTodoSnapshot(storage: StorageLike = localStorage): TodoSnapshot {
  try {
    const stored = storage.getItem(TODO_STORAGE_KEY)
    if (stored === null) return { todos: [], status: 'empty' }
    const parsed: unknown = JSON.parse(stored)
    if (!Array.isArray(parsed)) return { todos: [], status: 'corrupt' }
    return { todos: parsed as Todo[], status: 'ok' }
  } catch {
    return { todos: [], status: 'corrupt' }
  }
}

/**
 * 从 localStorage 读取待办（脏数据一律回退为空列表）
 *
 * 只是 `loadTodoSnapshot` 的薄包装，保留导出给不关心状态的调用方。
 *
 * @param storage 可注入，便于测试；默认用全局 localStorage
 */
export function loadTodos(storage: StorageLike = localStorage): Todo[] {
  return loadTodoSnapshot(storage).todos
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
