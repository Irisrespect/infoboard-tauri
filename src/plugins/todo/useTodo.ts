/**
 * 待办数据逻辑 Hook
 *
 * 负责：
 * 1. localStorage 持久化
 * 2. CRUD 操作（增删改查 + 切换完成）
 * 3. 筛选逻辑（全部 / 进行中 / 已完成）
 * 4. 统计数据（总数 / 已完成 / 未完成）
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import type { Todo, FilterType, UseTodoReturn } from './types'
import { compareTodosByDeadline, ISO_DATE_REGEX } from './utils'

/** localStorage 键名 */
const STORAGE_KEY = 'todo-list'

/** 生成简易 UUID */
function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2)
}

/**
 * 将日期字符串转换为本地时区当天结束时间（23:59:59.999）
 *
 * 解决两个问题：
 * 1. new Date("YYYY-MM-DD") 按 UTC 解析，与本地时区不一致
 * 2. 截止日期当天即被判定为逾期（应到 23:59:59 才算）
 */
function parseDeadlineToDayEnd(deadline: string): number | undefined {
  // ISO 格式：YYYY-MM-DD
  if (ISO_DATE_REGEX.test(deadline)) {
    const [year, month, day] = deadline.split('-').map(Number)
    // 使用本地时区构造当天 23:59:59.999
    return new Date(year, month - 1, day, 23, 59, 59, 999).getTime()
  }

  // 中文格式：M月D日
  const match = deadline.match(/^(\d{1,2})月(\d{1,2})日$/)
  if (match) {
    const month = parseInt(match[1], 10) - 1
    const day = parseInt(match[2], 10)
    const year = new Date().getFullYear()
    return new Date(year, month, day, 23, 59, 59, 999).getTime()
  }

  return undefined
}

/**
 * 迁移旧版截止时间数据
 * - "YYYY-MM-DD" 格式 → 计算 deadlineTs（当天结束时间）
 * - "6月20日" 格式 → 解析为当前年日期，转 ISO + deadlineTs
 * - 无法解析 → 保持原样，deadlineTs 为 undefined（排到底部）
 */
function normalizeTodo(todo: Todo): Todo {
  if (todo.deadline && !todo.deadlineTs) {
    const ts = parseDeadlineToDayEnd(todo.deadline)
    if (ts !== undefined) {
      // 如果是中文格式，同时转换为 ISO 格式
      if (/^\d{1,2}月\d{1,2}日$/.test(todo.deadline)) {
        const match = todo.deadline.match(/^(\d{1,2})月(\d{1,2})日$/)!
        const month = parseInt(match[1], 10)
        const day = parseInt(match[2], 10)
        const year = new Date().getFullYear()
        const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
        return { ...todo, deadline: iso, deadlineTs: ts }
      }
      return { ...todo, deadlineTs: ts }
    }
  }
  return todo
}

/** 从 localStorage 加载待办列表 */
function loadTodos(): Todo[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (!stored) return []
    const parsed = JSON.parse(stored)
    if (Array.isArray(parsed)) return parsed.map(normalizeTodo)
    return []
  } catch {
    return []
  }
}

/** 保存待办列表到 localStorage */
function saveTodos(todos: Todo[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(todos))
  } catch (err) {
    console.warn('[待办插件] 保存失败:', err)
  }
}

/**
 * 待办数据 Hook
 *
 * @example
 * ```tsx
 * const { todos, addTodo, toggleTodo, filter, setFilter, stats } = useTodo()
 * ```
 */
export function useTodo(): UseTodoReturn {
  const [todos, setTodos] = useState<Todo[]>(loadTodos)
  const [filter, setFilter] = useState<FilterType>('all')

  // 同步到 localStorage
  useEffect(() => {
    saveTodos(todos)
  }, [todos])

  /** 添加待办 */
  const addTodo = useCallback((text: string, deadline?: string) => {
    const trimmed = text.trim()
    if (!trimmed) return

    const trimmedDeadline = deadline?.trim() || undefined
    const deadlineTs = trimmedDeadline ? parseDeadlineToDayEnd(trimmedDeadline) : undefined

    const newTodo: Todo = {
      id: generateId(),
      text: trimmed,
      completed: false,
      deadline: trimmedDeadline,
      deadlineTs,
      createdAt: Date.now(),
    }
    setTodos((prev) => [newTodo, ...prev])
  }, [])

  /** 切换完成状态 */
  const toggleTodo = useCallback((id: string) => {
    setTodos((prev) =>
      prev.map((todo) => (todo.id === id ? { ...todo, completed: !todo.completed } : todo))
    )
  }, [])

  /** 删除待办 */
  const deleteTodo = useCallback((id: string) => {
    setTodos((prev) => prev.filter((todo) => todo.id !== id))
  }, [])

  /** 清除所有已完成 */
  const clearCompleted = useCallback(() => {
    setTodos((prev) => prev.filter((todo) => !todo.completed))
  }, [])

  // 筛选后的列表（按截止时间排序）
  const filteredTodos = useMemo(() => {
    let result: Todo[]
    switch (filter) {
      case 'active':
        result = todos.filter((t) => !t.completed)
        break
      case 'completed':
        result = todos.filter((t) => t.completed)
        break
      default:
        result = todos
    }

    // 排序：有截止时间的排前面（升序），无截止时间的排后面（按创建时间降序）
    return [...result].sort(compareTodosByDeadline)
  }, [todos, filter])

  // 统计数据
  const stats = useMemo(() => {
    const total = todos.length
    const completed = todos.filter((t) => t.completed).length
    return { total, completed, active: total - completed }
  }, [todos])

  return {
    todos: filteredTodos,
    allTodos: todos,
    addTodo,
    toggleTodo,
    deleteTodo,
    clearCompleted,
    filter,
    setFilter,
    stats,
  }
}
