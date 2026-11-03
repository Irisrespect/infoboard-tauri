/**
 * 待办数据逻辑 Hook
 *
 * 负责：
 * 1. localStorage 持久化（含损坏数据保护）
 * 2. CRUD 操作（增删改查 + 切换完成 + 撤销）
 * 3. 筛选逻辑（全部 / 进行中 / 已完成）
 * 4. 统计数据（总数 / 已完成 / 未完成）
 * 5. 跨天推进（todayTick，供 UI 重算逾期）
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import type { Todo, TodoPatch, FilterType, UseTodoReturn } from './types'
import {
  TODO_CORRUPT_KEY_PREFIX,
  TODO_STORAGE_KEY,
  isTodoOverdue,
  loadTodoSnapshot,
  nextLocalMidnightDelay,
  normalizeTodo,
  parseDeadlinePatch,
  parseDeadlineToDayEnd,
  saveTodos,
  compareTodosByDeadline,
} from './utils'

/** 生成简易 UUID */
function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2)
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
  // 快照只在挂载时读一次：status 用来判断"数据坏了，别急着用空列表覆盖"
  const [initial] = useState(() => loadTodoSnapshot())
  const [todos, setTodos] = useState<Todo[]>(() => initial.todos.map((t) => normalizeTodo(t)))
  const [filter, setFilter] = useState<FilterType>('all')
  // 跨天 / 窗口重新可见时自增，UI 依赖它重算逾期
  const [todayTick, setTodayTick] = useState(0)

  /**
   * 「本会话是否真的改过数据」——用脏标记而不是"跳过首帧"。
   *
   * 只有用户操作（增删改/切换/撤销）才会置位，因此挂载后即使 data 状态被重跑
   * （React.StrictMode 下 effect 会跑两遍）也不会把内存里的 [] 写回磁盘，
   * 损坏数据仍然完好躺在 localStorage / 备份键里。
   */
  const dirtyRef = useRef(false)

  // 损坏数据只备份一次：StrictMode 双跑 effect 时不能备份两遍、弹两次 toast
  const backedUpRef = useRef(false)

  // todos 的镜像：deleteTodo / clearCompleted 需要**同步**读出被删项
  const todosRef = useRef(todos)

  /**
   * 损坏数据保护（必须声明在写回 effect 之前：同一帧内先备份/置位，再执行写回判断）
   *
   * 备份原始字符串并提示用户，绝不静默覆盖。
   */
  useEffect(() => {
    if (initial.status !== 'corrupt') return
    if (backedUpRef.current) return
    backedUpRef.current = true
    try {
      const raw = localStorage.getItem(TODO_STORAGE_KEY)
      if (raw !== null) localStorage.setItem(`${TODO_CORRUPT_KEY_PREFIX}${Date.now()}`, raw)
    } catch (err) {
      console.error('[待办插件] 备份损坏数据失败:', err)
    }
    window.toastAPI?.show?.({
      message: '本地待办数据损坏，已保留原始数据未覆盖',
      color: '#f59e0b',
    })
  }, [initial])

  // 同步到 localStorage。写失败必须提示用户，不能静默丢数据。
  // 脏标记：没动过数据就不写盘 —— 挂载时的初始读（哪怕读坏了、读到空）不构成"用户的意图"。
  useEffect(() => {
    if (!dirtyRef.current) return
    if (saveTodos(todos)) return

    window.toastAPI?.show?.({
      message: '待办保存失败：本地存储写入被拒绝，本次改动可能丢失',
      color: '#ef4444',
    })
  }, [todos])

  // 镜像跟随最近一次已提交的 todos；事件回调里同步读取它拿"删除前的快照"
  useEffect(() => {
    todosRef.current = todos
  }, [todos])

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

  /** 添加待办（截止日期非法时忽略该项，不替用户改成别的日期） */
  const addTodo = useCallback((text: string, deadline?: string) => {
    dirtyRef.current = true

    const trimmed = text.trim()
    if (!trimmed) return

    const trimmedDeadline = deadline?.trim() || undefined
    const deadlineTs = trimmedDeadline ? parseDeadlineToDayEnd(trimmedDeadline) : undefined

    if (trimmedDeadline && deadlineTs === undefined) {
      window.toastAPI?.show?.({ message: `截止日期无效，已忽略：${trimmedDeadline}`, color: '#f59e0b' })
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
    setTodos((prev) => [newTodo, ...prev])
    // 添加后必须可见：停在"已完成"筛选下加完看不到，会以为没成功而重复输入
    setFilter('all')
  }, [])

  /** 切换完成状态 */
  const toggleTodo = useCallback((id: string) => {
    dirtyRef.current = true
    setTodos((prev) =>
      prev.map((todo) => (todo.id === id ? { ...todo, completed: !todo.completed } : todo))
    )
  }, [])

  /**
   * 局部编辑
   *
   * - `text` 先 trim，空串忽略（不让用户把待办改成空白）
   * - 含 `deadline` 时同步重算 `deadlineTs`；无法解析就**忽略这次 deadline 修改**，
   *   而不是清掉用户写的原文
   */
  const updateTodo = useCallback((id: string, patch: TodoPatch) => {
    dirtyRef.current = true
    setTodos((prev) =>
      prev.map((todo) => {
        if (todo.id !== id) return todo
        let next = todo

        if (patch.text !== undefined) {
          const trimmed = patch.text.trim()
          if (trimmed) next = { ...next, text: trimmed }
        }

        if ('deadline' in patch) {
          const parsed = parseDeadlinePatch(patch.deadline)
          if (parsed) next = { ...next, ...parsed }
        } else if ('deadlineTs' in patch) {
          next = { ...next, deadlineTs: patch.deadlineTs }
        }

        return next
      })
    )
  }, [])

  /** 删除待办，同步返回被删掉的那条（供 UI 做"撤销"） */
  const deleteTodo = useCallback((id: string): Todo | undefined => {
    dirtyRef.current = true
    const removed = todosRef.current.find((todo) => todo.id === id)
    setTodos((prev) => prev.filter((todo) => todo.id !== id))
    return removed
  }, [])

  /** 清除所有已完成，同步返回被清掉的列表（供 UI 做"撤销"） */
  const clearCompleted = useCallback((): Todo[] => {
    dirtyRef.current = true
    const removed = todosRef.current.filter((todo) => todo.completed)
    setTodos((prev) => prev.filter((todo) => !todo.completed))
    return removed
  }, [])

  /** 撤销单条删除：按 id 去重插回（位置交由消费方排序） */
  const restoreTodo = useCallback((todo: Todo) => {
    dirtyRef.current = true
    setTodos((prev) => (prev.some((t) => t.id === todo.id) ? prev : [...prev, todo]))
  }, [])

  /** 撤销批量清理：按 id 去重插回（位置交由消费方排序） */
  const restoreTodos = useCallback((restored: Todo[]) => {
    dirtyRef.current = true
    if (restored.length === 0) return
    setTodos((prev) => {
      const existing = new Set(prev.map((t) => t.id))
      const additions = restored.filter((t) => !existing.has(t.id))
      return additions.length === 0 ? prev : [...prev, ...additions]
    })
  }, [])

  // 筛选后的列表（按截止时间排序，已完成沉底）
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

    // 排序：未完成在前；组内有截止时间的在前（升序），无截止时间的按创建时间降序
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
    updateTodo,
    deleteTodo,
    restoreTodo,
    clearCompleted,
    restoreTodos,
    filter,
    setFilter,
    stats,
    todayTick,
    isOverdue: isTodoOverdue,
  }
}
