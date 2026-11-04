/**
 * 待办数据逻辑 Hook
 *
 * 数据本体（todos）与持久化都在 `store.ts`（模块级单一数据源），
 * 所以信息区卡片和工具区详情页看到的是**同一份状态**：一边删了，另一边立刻刷新，
 * 也不会互相覆盖写盘。
 *
 * 这个 hook 只负责"派生态 + 时间信号"：
 * 1. 首次挂载触发一次 `hydrate()`（幂等，两个挂载点都调也只读一次盘）
 * 2. 排序（已完成沉底，截止早的在前）
 * 3. 统计数据（总数 / 已完成 / 未完成）
 * 4. 跨天推进（todayTick，供 UI 重算逾期）
 *
 * **筛选不在这里**：它是每个视图自己的临时状态（信息区卡片 vs 工具区详情页各筛各的），
 * 由用到的组件自己 `useState`，避免两个视图互相串台。
 */

import { useEffect, useMemo, useState } from 'react'
import type { UseTodoReturn } from './types'
import { compareTodosByDeadline, isTodoOverdue, nextLocalMidnightDelay } from './utils'
import { useTodoStore } from './store'

/**
 * 待办数据 Hook
 *
 * @example
 * ```tsx
 * const { todos, addTodo, toggleTodo, stats } = useTodo()
 * ```
 */
export function useTodo(): UseTodoReturn {
  // 单一数据源：所有挂载点订阅同一个 store
  const allTodos = useTodoStore((state) => state.todos)
  // 以下 mutator 在 store 创建时就定了引用，跨渲染稳定，可直接进依赖数组
  const hydrate = useTodoStore((state) => state.hydrate)
  const addTodo = useTodoStore((state) => state.addTodo)
  const toggleTodo = useTodoStore((state) => state.toggleTodo)
  const updateTodo = useTodoStore((state) => state.updateTodo)
  const deleteTodo = useTodoStore((state) => state.deleteTodo)
  const restoreTodo = useTodoStore((state) => state.restoreTodo)
  const clearCompleted = useTodoStore((state) => state.clearCompleted)
  const restoreTodos = useTodoStore((state) => state.restoreTodos)

  // 跨天 / 窗口重新可见时自增，UI 依赖它重算逾期
  const [todayTick, setTodayTick] = useState(0)

  // 首次挂载读一次盘。hydrate 内部幂等：卡片与详情页同时挂载也只真正读一次。
  useEffect(() => {
    hydrate()
  }, [hydrate])

  /** 跨天 / 窗口重新可见 → todayTick +1；定时器与监听器必须清理 */
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined

    const scheduleNextMidnight = () => {
      timer = setTimeout(() => {
        setTodayTick((n) => n + 1)
        scheduleNextMidnight()
      }, nextLocalMidnightDelay())
    }
    scheduleNextMidnight()

    const bump = () => setTodayTick((n) => n + 1)
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') bump()
    }

    window.addEventListener('focus', bump)
    document.addEventListener('visibilitychange', handleVisibility)

    return () => {
      if (timer !== undefined) clearTimeout(timer)
      window.removeEventListener('focus', bump)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [])

  // 列表（按截止时间排序，已完成沉底）
  const sortedTodos = useMemo(() => {
    // 排序：未完成在前；组内有截止时间的在前（升序），无截止时间的按创建时间降序
    return [...allTodos].sort(compareTodosByDeadline)
  }, [allTodos])

  // 统计数据
  const stats = useMemo(() => {
    const total = allTodos.length
    const completed = allTodos.filter((t) => t.completed).length
    return { total, completed, active: total - completed }
  }, [allTodos])

  return {
    todos: sortedTodos,
    allTodos,
    addTodo,
    toggleTodo,
    updateTodo,
    deleteTodo,
    restoreTodo,
    clearCompleted,
    restoreTodos,
    stats,
    todayTick,
    isOverdue: isTodoOverdue,
  }
}
