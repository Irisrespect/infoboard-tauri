/**
 * 待办卡片组件
 *
 * 完全按照 Pencil 设计稿还原：
 * - 折叠态：list-checks 图标 + 标题 + 未完成数
 * - 展开态：头部 + 进度条 + 输入框 + 筛选 + 待办列表
 * - 动画：grid-template-rows 实现展开/折叠（参考 InfoSection.tsx）
 */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import type { PluginComponentProps } from '../../core/types'
import type { Todo, FilterType } from './types'
import { useTodo } from './useTodo'
import { useThemeColors } from '../../hooks/useThemeColors'
import { AccentProvider, useAccent } from '../../hooks/useAccent'
import { withAlpha } from '../../utils/themeColor'
import { getFirstActiveTodo, ISO_DATE_REGEX } from './utils'

// ─── 主题色 ───
// 子组件通过 useAccent() 从 Context 读取，不再用模块级可变变量
// （原先 `let ACCENT` + 渲染期赋值：渲染期副作用，并发渲染下会撕裂）

// ─── 日期格式化 ───

/** 将 "YYYY-MM-DD" 转为中文显示格式，如 "6月20日"（跨年显示年份） */
function formatDeadline(iso: string | undefined | null): string {
  if (!iso) return ''
  const match = String(iso).match(ISO_DATE_REGEX)
  if (!match) return String(iso)
  const year = parseInt(match[1], 10)
  const month = parseInt(match[2], 10)
  const day = parseInt(match[3], 10)
  if (isNaN(year) || isNaN(month) || isNaN(day)) return String(iso)
  if (year !== new Date().getFullYear()) {
    return `${year}年${month}月${day}日`
  }
  return `${month}月${day}日`
}

// ─── Lucide 图标（从 lucide-react 导入） ───
import { ListChecks, ChevronDown, Check, Plus, Trash2, Calendar, Circle } from 'lucide-react'

// ─── 筛选配置 ───

const FILTER_OPTIONS: { key: FilterType; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'active', label: '进行中' },
  { key: 'completed', label: '已完成' },
]

/**
 * 待办卡片主组件
 */
export function TodoCard({ manifest, expanded }: PluginComponentProps) {
  const {
    todos,
    allTodos,
    addTodo,
    toggleTodo,
    deleteTodo,
    clearCompleted,
    filter,
    setFilter,
    stats,
  } = useTodo()
  const { accent } = useThemeColors()
  const [inputValue, setInputValue] = useState('')
  const [deadlineValue, setDeadlineValue] = useState('')
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const datePickerRef = useRef<HTMLInputElement>(null)

  // 折叠态显示的第一条待办（取截止时间最早的未完成项）
  // 使用 useMemo 避免每次渲染都重新排序
  const firstActiveTodo = useMemo(() => getFirstActiveTodo(allTodos), [allTodos])

  const handleAdd = useCallback(() => {
    if (inputValue.trim()) {
      addTodo(inputValue, deadlineValue)
      setInputValue('')
      setDeadlineValue('')
    }
  }, [inputValue, deadlineValue, addTodo])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        handleAdd()
      }
    },
    [handleAdd]
  )

  // 展开时聚焦输入框
  useEffect(() => {
    if (expanded && inputRef.current) {
      // 延迟聚焦，等待动画完成
      const timer = setTimeout(() => inputRef.current?.focus(), 300)
      return () => clearTimeout(timer)
    }
  }, [expanded])

  return (
    <AccentProvider value={accent}>
      <div className="relative">
        {/* 折叠摘要：始终可见 */}
        <CompactView activeCount={stats.active} firstTodo={firstActiveTodo} />

        {/* 展开详情：grid 行高动画 0fr ↔ 1fr */}
        <div
          className="transition-[grid-template-rows] duration-500 ease-[cubic-bezier(0.4,0,0.2,1)]"
          style={{
            display: 'grid',
            gridTemplateRows: expanded ? '1fr' : '0fr',
          }}
        >
          <div className="overflow-hidden min-h-0">
            <ExpandedView
              todos={todos}
              stats={stats}
              filter={filter}
              setFilter={setFilter}
              inputValue={inputValue}
              setInputValue={setInputValue}
              deadlineValue={deadlineValue}
              setDeadlineValue={setDeadlineValue}
              inputRef={inputRef}
              datePickerRef={datePickerRef}
              hoveredId={hoveredId}
              setHoveredId={setHoveredId}
              onAdd={handleAdd}
              onKeyDown={handleKeyDown}
              onToggle={toggleTodo}
              onDelete={deleteTodo}
              onClearCompleted={clearCompleted}
            />
          </div>
        </div>
      </div>
    </AccentProvider>
  )
}

// ─── 折叠视图 ───

function CompactView({ activeCount, firstTodo }: { activeCount: number; firstTodo?: Todo }) {
  const ACCENT = useAccent()
  return (
    <div className="flex flex-col gap-2.5">
      {/* 顶部行：图标 + 标题 + 未完成数 + chevron */}
      <div className="flex items-center gap-3">
        <div
          className="flex items-center justify-center w-9 h-9 rounded-full shrink-0"
          style={{ backgroundColor: withAlpha(ACCENT, 0.08) }}
        >
          <ListChecks size={18} color={ACCENT} />
        </div>
        <div className="flex flex-col">
          <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            待办
          </span>
          <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
            {activeCount}项未完成
          </span>
        </div>
        <div className="ml-auto">
          <ChevronDown size={16} color="var(--text-muted)" />
        </div>
      </div>

      {/* 第一条待办预览 */}
      {firstTodo && (
        <div
          className="flex items-center gap-2.5 px-3 py-2 rounded-lg"
          style={{ backgroundColor: 'var(--bg-main)' }}
        >
          <Circle size={14} color={ACCENT} />
          <span
            className="flex-1 text-[13px] truncate"
            style={{ color: 'var(--text-primary)', fontFamily: 'Inter' }}
          >
            {firstTodo.text}
          </span>
          {/* 截止时间 */}
          {firstTodo.deadline ? (
            <span className="flex items-center gap-1 shrink-0">
              <Calendar size={11} color="var(--text-muted)" />
              <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                {formatDeadline(firstTodo.deadline)}
              </span>
            </span>
          ) : null}
        </div>
      )}
    </div>
  )
}

// ─── 展开视图 ───

interface ExpandedViewProps {
  todos: Todo[]
  stats: { total: number; completed: number; active: number }
  filter: FilterType
  setFilter: (f: FilterType) => void
  inputValue: string
  setInputValue: (v: string) => void
  deadlineValue: string
  setDeadlineValue: (v: string) => void
  inputRef: React.RefObject<HTMLInputElement | null>
  datePickerRef: React.RefObject<HTMLInputElement | null>
  hoveredId: string | null
  setHoveredId: (id: string | null) => void
  onAdd: () => void
  onKeyDown: (e: React.KeyboardEvent) => void
  onToggle: (id: string) => void
  onDelete: (id: string) => void
  onClearCompleted: () => void
}

function ExpandedView({
  todos,
  stats,
  filter,
  setFilter,
  inputValue,
  setInputValue,
  deadlineValue,
  setDeadlineValue,
  inputRef,
  datePickerRef,
  hoveredId,
  setHoveredId,
  onAdd,
  onKeyDown,
  onToggle,
  onDelete,
  onClearCompleted,
}: ExpandedViewProps) {
  const ACCENT = useAccent()
  const progressPercent = stats.total > 0 ? (stats.completed / stats.total) * 100 : 0

  return (
    <div className="flex flex-col gap-3 mt-3">
      {/* 头部行 */}
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
          待办事项
        </span>
        <span
          className="text-[11px] font-semibold rounded-full px-2 py-0.5"
          style={{ color: ACCENT, backgroundColor: withAlpha(ACCENT, 0.08) }}
        >
          {stats.completed}/{stats.total} 完成
        </span>
      </div>

      {/* 进度条 */}
      <div className="h-1 rounded-full w-full" style={{ backgroundColor: 'var(--border-subtle)' }}>
        <div
          className="h-1 rounded-full transition-all duration-300"
          style={{ backgroundColor: ACCENT, width: `${progressPercent}%` }}
        />
      </div>

      {/* 添加输入框 */}
      <div className="flex flex-col gap-2">
        <div
          className="flex items-center gap-2 h-[38px] rounded-lg px-3"
          style={{ border: '1px solid var(--border-subtle)' }}
        >
          <Plus size={16} color="var(--text-muted)" />
          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              onKeyDown(e)
            }}
            placeholder="添加新待办..."
            className="flex-1 bg-transparent text-[13px] outline-none"
            style={{ color: 'var(--text-primary)', fontFamily: 'Inter' }}
            onClick={(e) => e.stopPropagation()}
          />
        </div>
        {/* 截止时间输入 */}
        <div
          className="flex items-center gap-2 h-[32px] rounded-lg px-3"
          style={{ border: '1px solid var(--border-subtle)' }}
        >
          <Calendar size={14} color="var(--text-muted)" />
          <input
            type="text"
            value={deadlineValue}
            placeholder="YYYY-MM-DD 或 7月8日"
            onChange={(e) => setDeadlineValue(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              onKeyDown(e)
            }}
            className="flex-1 bg-transparent text-[12px] outline-none"
            style={{ color: 'var(--text-primary)', fontFamily: 'Inter' }}
            onClick={(e) => e.stopPropagation()}
          />
          <div
            className="relative shrink-0"
            style={{ width: 28, height: 28 }}
            onClick={(e) => e.stopPropagation()}
          >
            <input
              type="date"
              ref={datePickerRef}
              onChange={(e) => {
                if (e.target.value) {
                  setDeadlineValue(e.target.value)
                }
              }}
              className="absolute inset-0 opacity-0 cursor-pointer"
              style={{ width: '100%', height: '100%' }}
            />
            <div className="pointer-events-none p-1">
              <Calendar size={14} color="var(--text-muted)" />
            </div>
          </div>
        </div>
      </div>

      {/* 筛选标签 */}
      <div className="flex items-center gap-2">
        {FILTER_OPTIONS.map((opt) => {
          const isActive = filter === opt.key
          return (
            <button
              key={opt.key}
              className="text-xs rounded-md px-3 py-1 transition-colors"
              style={{
                color: isActive ? ACCENT : 'var(--text-muted)',
                backgroundColor: isActive ? withAlpha(ACCENT, 0.08) : 'var(--bg-main)',
                fontWeight: isActive ? 600 : 400,
              }}
              onClick={(e) => {
                e.stopPropagation()
                setFilter(opt.key)
              }}
            >
              {opt.label}
            </button>
          )
        })}
        {/* 一键清理按钮（仅在"已完成"筛选下显示） */}
        {filter === 'completed' && stats.completed > 0 && (
          <button
            className="text-xs rounded-md px-3 py-1 ml-auto transition-colors hover:opacity-80"
            style={{ color: '#DC2626', backgroundColor: '#FEE2E2' }}
            onClick={(e) => {
              e.stopPropagation()
              onClearCompleted()
            }}
          >
            一键清理
          </button>
        )}
      </div>

      {/* 待办列表 */}
      <div className="flex flex-col gap-1.5">
        {todos.length === 0 ? (
          <div className="text-center py-4">
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {filter === 'all' ? '暂无待办，添加一个吧' : '没有匹配的待办'}
            </span>
          </div>
        ) : (
          todos.map((todo) => (
            <TodoItem
              key={todo.id}
              todo={todo}
              isHovered={hoveredId === todo.id}
              onMouseEnter={() => setHoveredId(todo.id)}
              onMouseLeave={() => setHoveredId(null)}
              onToggle={onToggle}
              onDelete={onDelete}
            />
          ))
        )}
      </div>
    </div>
  )
}

// ─── 待办项 ───

interface TodoItemProps {
  todo: Todo
  isHovered: boolean
  onMouseEnter: () => void
  onMouseLeave: () => void
  onToggle: (id: string) => void
  onDelete: (id: string) => void
}

function TodoItem({
  todo,
  isHovered,
  onMouseEnter,
  onMouseLeave,
  onToggle,
  onDelete,
}: TodoItemProps) {
  const ACCENT = useAccent()
  // 计算是否逾期（截止日期当天不算逾期，因为我们存储的是当天 23:59:59）
  const isOverdue = !todo.completed && todo.deadlineTs != null && todo.deadlineTs < Date.now()

  return (
    <div
      className="flex items-center gap-2.5 py-2 px-0 rounded-md transition-colors"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {/* 勾选框 */}
      <div
        className="flex items-center justify-center shrink-0 cursor-pointer"
        style={{
          width: 18,
          height: 18,
          borderRadius: 4,
          backgroundColor: todo.completed ? ACCENT : 'var(--bg-surface)',
          border: todo.completed ? 'none' : '1.5px solid var(--border-subtle)',
        }}
        onClick={(e) => {
          e.stopPropagation()
          onToggle(todo.id)
        }}
      >
        {todo.completed && <Check size={12} color="#fff" />}
      </div>

      {/* 文字 */}
      <span
        className="text-[13px]"
        style={{
          color: todo.completed ? 'var(--text-muted)' : 'var(--text-primary)',
          textDecoration: todo.completed ? 'line-through' : 'none',
          fontFamily: 'Inter',
        }}
      >
        {todo.text}
      </span>

      {/* 截止时间 */}
      {todo.deadline ? (
        <span className="flex items-center gap-1 shrink-0">
          <Calendar size={11} color={isOverdue ? '#DC2626' : 'var(--text-muted)'} />
          <span
            className="text-[10px]"
            style={{ color: isOverdue ? '#DC2626' : 'var(--text-muted)' }}
          >
            {formatDeadline(todo.deadline)}
          </span>
        </span>
      ) : null}

      {/* 删除按钮（悬停显示） */}
      {isHovered && (
        <button
          className="shrink-0 opacity-50 hover:opacity-100 transition-opacity"
          onClick={(e) => {
            e.stopPropagation()
            onDelete(todo.id)
          }}
        >
          <Trash2 size={14} color="var(--text-muted)" />
        </button>
      )}
    </div>
  )
}
