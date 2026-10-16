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
import {
  CN_DATE_REGEX,
  chineseDateToIso,
  compareTodosByDeadline,
  loadTodos,
  parseDeadlineToDayEnd,
  saveTodos,
} from './utils'

/** 生成简易 UUID */
function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2)
}

/**
 * 迁移旧版截止时间数据
 * - "YYYY-MM-DD" 格式 → 计算 deadlineTs（当天结束时间）
 * - "6月20日" 格式 → 解析为当前年日期，转 ISO + deadlineTs
 * - 无法解析 / 日期不存在（如 2月30日）→ 清掉截止时间（不替用户改日期）
 */
function normalizeTodo(todo: Todo): Todo {
  if (!todo.deadline || todo.deadlineTs) return todo

  const ts = parseDeadlineToDayEnd(todo.deadline)
  if (ts === undefined) {
    return { ...todo, deadline: undefined, deadlineTs: undefined }
  }
  if (CN_DATE_REGEX.test(todo.deadline)) {
    const iso = chineseDateToIso(todo.deadline)
    return { ...todo, deadline: iso ?? undefined, deadlineTs: ts }
  }
  return { ...todo, deadlineTs: ts }
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
  const [todos, setTodos] = useState<Todo[]>(() => loadTodos().map(normalizeTodo))
  const [filter, setFilter] = useState<FilterType>('all')

  // 同步到 localStorage。写失败必须提示用户，不能静默丢数据。
  useEffect(() => {
    if (saveTodos(todos)) return
    window.toastAPI?.show?.({
      message: '待办保存失败：本地存储写入被拒绝，本次改动可能丢失',
      color: '#ef4444',
    })
  }, [todos])

  /** 添加待办（截止日期非法时忽略该项，不替用户改成别的日期） */
  const addTodo = useCallback((text: string, deadline?: string) => {
    const trimmed = text.trim()
    if (!trimmed) return

    const trimmedDeadline = deadline?.trim() || undefined
    const deadlineTs = trimmedDeadline ? parseDeadlineToDayEnd(trimmedDeadline) : undefined

    if (trimmedDeadline && deadlineTs === undefined) {
      window.toastAPI?.show?.({ message: `截止日期无效，已忽略：${trimmedDeadline}`, color: '#f59e0b' })
    }

    const newTodo: Todo = {
      id: generateId(),
      text: trimmed,
      completed: false,
      deadline: deadlineTs === undefined ? undefined : trimmedDeadline,
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
