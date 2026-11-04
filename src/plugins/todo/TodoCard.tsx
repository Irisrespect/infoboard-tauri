/**
 * 待办卡片组件
 *
 * 完全按照 Pencil 设计稿还原：
 * - 折叠态：list-checks 图标 + 标题 + 未完成数
 * - 展开态：进度条 + 输入框 + 筛选 + 待办列表
 * - 动画：grid-template-rows 实现展开/折叠（参考 InfoSection.tsx）
 *
 * 职责边界：信息区卡片只负责 **看 / 勾选 / 快速添加 / 折叠**。
 * 条目级的删除、编辑都在工具区的「详细管理」页做，卡片上不放这些入口。
 */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import type { PluginComponentProps } from '../../core/types'
import type { Todo, FilterType } from './types'
import { useTodo } from './useTodo'
import { useThemeColors } from '../../hooks/useThemeColors'
import { AccentProvider, useAccent } from '../../hooks/useAccent'
import { withAlpha } from '../../utils/themeColor'
import { getFirstActiveTodo, ISO_DATE_REGEX, formatDeadline, parseDeadlineToDayEnd } from './utils'

// ─── 主题色 ───
// 子组件通过 useAccent() 从 Context 读取，不再用模块级可变变量
// （原先 `let ACCENT` + 渲染期赋值：渲染期副作用，并发渲染下会撕裂）

/**
 * 输入法正在拼字时的键盘事件判定
 *
 * 中文/日文输入法里 Enter 是"确认候选词"，不是"提交"。`isComposing` 是标准属性；
 * 少数输入法只在 keydown 上给出 keyCode 229，所以两个都判。
 */
function isComposingEvent(e: React.KeyboardEvent): boolean {
  const native = e.nativeEvent as KeyboardEvent
  return native.isComposing || native.keyCode === 229
}

// ─── Lucide 图标（从 lucide-react 导入） ───
import { ListChecks, ChevronDown, Check, Plus, Calendar, Circle } from 'lucide-react'

// ─── 筛选配置 ───

const FILTER_OPTIONS: { key: FilterType; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'active', label: '进行中' },
  { key: 'completed', label: '已完成' },
]

/** 列表行：待办 + 渲染期算好的逾期标记 */
interface TodoRow {
  todo: Todo
  overdue: boolean
}

/**
 * 待办卡片属性
 *
 * `onToggle` 由 InfoCard 额外注入（核心的 PluginComponentProps 里没有），
 * 缺省时退化成"整张卡片可点"的旧行为，因此保持可选。
 */
export interface TodoCardProps extends PluginComponentProps {
  /** 折叠 / 展开回调（InfoCard 注入） */
  onToggle?: () => void
}

/**
 * 待办卡片主组件
 */
export function TodoCard({ manifest, expanded, onToggle }: TodoCardProps) {
  const { todos, allTodos, addTodo, toggleTodo, clearCompleted, restoreTodos, stats, todayTick, isOverdue } =
    useTodo()
  const { accent } = useThemeColors()
  const [inputValue, setInputValue] = useState('')
  const [deadlineValue, setDeadlineValue] = useState('')
  /**
   * 筛选是**卡片自己的**临时状态，不进共享 store：
   * 工具区的详细管理页也有一套筛选，放 store 里会互相串台
   * （详情页切到"已完成"，信息区卡片跟着只剩已完成项）。
   */
  const [filter, setFilter] = useState<FilterType>('all')
  const inputRef = useRef<HTMLInputElement>(null)
  const datePickerRef = useRef<HTMLInputElement>(null)

  // 折叠态显示的第一条待办（取截止时间最早的未完成项）
  // 使用 useMemo 避免每次渲染都重新排序
  const firstActiveTodo = useMemo(() => getFirstActiveTodo(allTodos), [allTodos])

  // 逾期标记：isOverdue() 内部读的是 Date.now()，React 不会因为"时间流逝"重渲染，
  // 所以把 useTodo 的跨天信号 todayTick 一起作为依赖 —— 跨天 / 窗口重新可见后
  // 用最新的"现在"重算一遍逾期，而不是靠 hover 之类的偶然重渲染。
  // 筛选也在这里做：`todos` 现在是「已排序的全量」，筛的是卡片自己那份 filter。
  const rows = useMemo<TodoRow[]>(
    () =>
      todos
        .filter((todo) => {
          if (filter === 'active') return !todo.completed
          if (filter === 'completed') return todo.completed
          return true
        })
        .map((todo) => ({ todo, overdue: isOverdue(todo) })),
    [todos, filter, isOverdue, todayTick]
  )

  const handleAdd = useCallback(() => {
    const text = inputValue.trim()
    if (!text) return

    const deadlineText = deadlineValue.trim()
    // 非法截止日期不提交，也不清空输入（让用户原地改，而不是丢掉他写的东西）
    if (deadlineText && parseDeadlineToDayEnd(deadlineText) === undefined) {
      window.toastAPI?.show?.({
        message: '截止日期无效，请检查格式',
        color: 'var(--danger)',
      })
      return
    }

    addTodo(text, deadlineText || undefined)
    setInputValue('')
    setDeadlineValue('')
    // 新增后必须让用户看见：停在「已完成」筛选下加完什么都看不到，会以为没成功而重复输入
    setFilter('all')
  }, [inputValue, deadlineValue, addTodo])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // 输入法拼字中的 Enter 是在选词，不能提交
      if (isComposingEvent(e)) return
      if (e.key === 'Enter') {
        e.preventDefault()
        handleAdd()
      }
    },
    [handleAdd]
  )

  /** 一键清理已完成 + 可撤销提示（没清掉任何东西就不打扰用户） */
  const handleClearCompleted = useCallback(() => {
    const removed = clearCompleted()
    if (removed.length === 0) return
    window.toastAPI?.show?.({
      message: `已清理 ${removed.length} 条已完成`,
      color: 'var(--danger)',
      action: { label: '撤销', onClick: () => restoreTodos(removed) },
    })
  }, [clearCompleted, restoreTodos])

  // 展开时聚焦输入框
  useEffect(() => {
    if (!expanded) return
    // 只等一帧（而不是等 500ms 动画）：preventScroll 保证不会把视口滚出去
    const raf = requestAnimationFrame(() => {
      inputRef.current?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(raf)
  }, [expanded])

  // 展开容器的 id：InfoCard 的 aria-controls 按 `{pluginId}-panel` 约定指向它
  const panelId = `${manifest.id}-panel`

  return (
    <AccentProvider value={accent}>
      {/*
        整张卡片（含 InfoCard 的 p-4 内边距、卡片根的空白、行间隙）都不折叠自己：
        折叠入口只保留 CompactView 头部那一个（它已有自己的 onToggle），
        否则点内边距/空白处会把卡片收起来，用户还会以为是自己点到了什么。

        `-m-4 p-4` 是为了把 InfoCard 的 16px 内边距圈也纳入止泡范围：
        InfoSection 的结构是「卡片根(onToggle) > div.p-4 > 插件组件」，只靠这里的
        止泡只覆盖 `.p-4` 的**内容盒**，落在那一圈 16px 内边距上的点击命中的是
        `DIV.p-4`，事件绕过本组件直接冒到卡片根 → 卡片被收起。
        负外边距抵消掉自身内边距，盒子向外撑进那圈 padding：内容位置一个像素都不变
        （`-m-4` + `p-4` 净效果为 0），但整圈内边距落在本组件内，止泡真正覆盖整张卡片。
        数值与 InfoSection.tsx 里的 `p-4` 绑定，改那边必须同步改这里。
      */}
      <div className="relative -m-4 p-4" onClick={(e) => e.stopPropagation()}>
        {/* 折叠摘要：始终可见，头部是唯一的展开/折叠入口 */}
        <CompactView
          activeCount={stats.active}
          firstTodo={firstActiveTodo}
          expanded={!!expanded}
          onToggle={onToggle}
        />

        {/* 展开详情：grid 行高动画 0fr ↔ 1fr */}
        <div
          id={panelId}
          className="transition-[grid-template-rows] duration-500 ease-[cubic-bezier(0.4,0,0.2,1)]"
          style={{
            display: 'grid',
            gridTemplateRows: expanded ? '1fr' : '0fr',
          }}
        >
          {/*
            inert：收起后内容仍留在 DOM 里（保留动画与状态），但整棵子树不能
            被 Tab 聚焦、也不能被点击 —— 否则键盘用户会 Tab 进看不见的输入框。
            onClick 止泡：展开区（含上边距、行间隙）里的任何点击都不折叠卡片。
          */}
          <div
            className="overflow-hidden min-h-0"
            inert={!expanded}
            onClick={(e) => e.stopPropagation()}
          >
            <ExpandedView
              rows={rows}
              stats={stats}
              filter={filter}
              setFilter={setFilter}
              inputValue={inputValue}
              setInputValue={setInputValue}
              deadlineValue={deadlineValue}
              setDeadlineValue={setDeadlineValue}
              inputRef={inputRef}
              datePickerRef={datePickerRef}
              onAdd={handleAdd}
              onKeyDown={handleKeyDown}
              onToggle={toggleTodo}
              onClearCompleted={handleClearCompleted}
            />
          </div>
        </div>
      </div>
    </AccentProvider>
  )
}

// ─── 折叠视图 ───

interface CompactViewProps {
  activeCount: number
  firstTodo?: Todo
  expanded: boolean
  /** 未提供时（比如被别处单独渲染）交给外层 InfoCard 的整卡点击兜底 */
  onToggle?: () => void
}

function CompactView({ activeCount, firstTodo, expanded, onToggle }: CompactViewProps) {
  const ACCENT = useAccent()

  const handleHeaderClick = (e: React.MouseEvent) => {
    if (!onToggle) return
    // 自己是折叠入口：阻止冒泡，否则 InfoCard 根节点的 onClick 会再切一次（等于没动）
    e.stopPropagation()
    onToggle()
  }

  const handlePreviewClick = (e: React.MouseEvent) => {
    // 折叠态下最显眼的可点区域，点它就展开；没有注入 onToggle 时留给 InfoCard 整卡点击兜底
    if (!onToggle) return
    e.stopPropagation()
    onToggle()
  }

  return (
    <div className="flex flex-col gap-2.5">
      {/* 顶部行（折叠/展开触发区）：图标 + 标题 + 未完成数 + chevron */}
      <div className="flex items-center gap-3 cursor-pointer" onClick={handleHeaderClick}>
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
          <ChevronDown
            size={16}
            color="var(--text-muted)"
            style={{
              transform: expanded ? 'rotate(180deg)' : 'none',
              transition: 'transform 300ms',
            }}
          />
        </div>
      </div>

      {/*
        第一条待办预览：只在折叠态显示（展开后列表第一行就是它，再显示一次就是重复）；
        点击 = 展开 —— 这是折叠态最显眼的可点区域，点它没反应等于"坏了"。
      */}
      {!expanded && firstTodo && (
        <div
          className="flex items-center gap-2.5 px-3 py-2 rounded-lg cursor-pointer"
          style={{ backgroundColor: 'var(--bg-main)' }}
          title="展开待办"
          onClick={handlePreviewClick}
        >
          <Circle size={14} color={ACCENT} />
          <span
            className="flex-1 min-w-0 truncate text-[13px]"
            style={{ color: 'var(--text-primary)', fontFamily: 'Inter' }}
            title={firstTodo.text}
          >
            {firstTodo.text}
          </span>
          {/* 截止时间 */}
          {firstTodo.deadline ? (
            <span className="flex items-center gap-1 shrink-0">
              <Calendar size={11} color="var(--text-secondary)" />
              <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
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
  rows: TodoRow[]
  stats: { total: number; completed: number; active: number }
  filter: FilterType
  setFilter: (f: FilterType) => void
  inputValue: string
  setInputValue: (v: string) => void
  deadlineValue: string
  setDeadlineValue: (v: string) => void
  inputRef: React.RefObject<HTMLInputElement | null>
  datePickerRef: React.RefObject<HTMLInputElement | null>
  onAdd: () => void
  onKeyDown: (e: React.KeyboardEvent) => void
  onToggle: (id: string) => void
  onClearCompleted: () => void
}

function ExpandedView({
  rows,
  stats,
  filter,
  setFilter,
  inputValue,
  setInputValue,
  deadlineValue,
  setDeadlineValue,
  inputRef,
  datePickerRef,
  onAdd,
  onKeyDown,
  onToggle,
  onClearCompleted,
}: ExpandedViewProps) {
  const ACCENT = useAccent()
  const progressPercent = stats.total > 0 ? (stats.completed / stats.total) * 100 : 0

  return (
    // 展开态内的任何点击都不该折叠卡片（进度条、行间隙、空状态、文字……）
    <div className="flex flex-col gap-3 mt-3" onClick={(e) => e.stopPropagation()}>
      {/* 进度条 + 完成数徽标 */}
      <div className="flex items-center gap-2">
        <div
          className="h-1 flex-1 rounded-full"
          style={{ backgroundColor: 'var(--border-subtle)' }}
        >
          <div
            className="h-1 rounded-full transition-all duration-300"
            style={{ backgroundColor: ACCENT, width: `${progressPercent}%` }}
          />
        </div>
        <span
          className="shrink-0 text-[11px] font-semibold rounded-full px-2 py-0.5"
          style={{ color: ACCENT, backgroundColor: withAlpha(ACCENT, 0.08) }}
        >
          {stats.completed}/{stats.total} 完成
        </span>
      </div>

      {/* 添加输入框 */}
      <div className="flex flex-col gap-2">
        <div
          className="flex items-center gap-2 h-[38px] rounded-lg px-3"
          style={{ border: '1px solid var(--border-subtle)' }}
        >
          {/*
            「+」是提交按钮（同 Enter）：空输入时 handleAdd 自己 return，不会有副作用。
            命中区 24×24，键盘可 Tab 到并有 focus-visible 可见样式。
          */}
          <button
            type="button"
            aria-label="添加待办"
            title="添加"
            onClick={onAdd}
            className="flex items-center justify-center shrink-0 w-6 h-6 rounded cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
            style={{ outlineColor: 'var(--accent)' }}
          >
            <Plus size={16} color={ACCENT} />
          </button>
          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => {
              // 必须阻止冒泡：卡片根节点的 onKeyDown 会把 Enter 当成折叠
              e.stopPropagation()
              onKeyDown(e)
            }}
            placeholder="添加新待办..."
            className="flex-1 bg-transparent text-[13px] outline-none"
            style={{ color: 'var(--text-primary)', fontFamily: 'Inter' }}
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
          />
          <div className="relative shrink-0" style={{ width: 28, height: 28 }}>
            <input
              type="date"
              ref={datePickerRef}
              // 移出 Tab 序：这个框是完全不可见的（opacity-0，只负责盖住日历图标接鼠标点击），
              // 但 Chrome 原生日期控件在 Tab 序列里会按「年 / 月 / 日 / 日历按钮」连占 4 次停靠，
              // 键盘用户会被硬拽进一个看不见的控件。tabIndex=-1 不影响鼠标点击（鼠标走命中测试，
              // 与 Tab 序无关）；键盘用户用上面的文本框直接输入 YYYY-MM-DD，能力没有丢失。
              tabIndex={-1}
              // 受控：只有 ISO 值才回填（"7月8日"这类不是 date input 的合法值，
              // 直接塞进去浏览器会丢掉，值会静默变成空）
              value={ISO_DATE_REGEX.test(deadlineValue) ? deadlineValue : ''}
              // 无条件回填：type=date 的空值就是用户想清空日期，不能因为"假值"就吞掉
              onChange={(e) => setDeadlineValue(e.target.value)}
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
              type="button"
              className="text-xs rounded-md px-3 py-1 transition-colors"
              style={{
                color: isActive ? ACCENT : 'var(--text-muted)',
                backgroundColor: isActive ? withAlpha(ACCENT, 0.08) : 'var(--bg-main)',
                fontWeight: isActive ? 600 : 400,
              }}
              onClick={() => setFilter(opt.key)}
            >
              {opt.label}
            </button>
          )
        })}
        {/* 一键清理按钮（仅在"已完成"筛选下显示） */}
        {filter === 'completed' && stats.completed > 0 && (
          <button
            type="button"
            className="text-xs rounded-md px-3 py-1 ml-auto transition-colors hover:opacity-80"
            style={{ color: 'var(--danger)', backgroundColor: 'var(--danger-bg)' }}
            onClick={onClearCompleted}
          >
            一键清理
          </button>
        )}
      </div>

      {/* 待办列表 */}
      <div className="flex flex-col gap-1.5">
        {rows.length === 0 ? (
          <div className="text-center py-4">
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {filter === 'all' ? '暂无待办，添加一个吧' : '没有匹配的待办'}
            </span>
          </div>
        ) : (
          rows.map(({ todo, overdue }) => (
            <TodoItem key={todo.id} todo={todo} overdue={overdue} onToggle={onToggle} />
          ))
        )}
      </div>
    </div>
  )
}

// ─── 待办项 ───

interface TodoItemProps {
  todo: Todo
  /** 逾期判定结果（由 TodoCard 用 useTodo().isOverdue + todayTick 算出） */
  overdue: boolean
  onToggle: (id: string) => void
}

function TodoItem({ todo, overdue, onToggle }: TodoItemProps) {
  const ACCENT = useAccent()

  return (
    /*
      故意不做「整行点击 = 切换完成」：挂 onClick 会带来两类误操作 ——
      1) 拖选文字想复制，松手后浏览器补发 click → 待办被静默勾掉；
      2) 双击一行：第一击置完成并立刻沉底重排，第二击落到顶替上来的另一行 → 又勾一条。
      而 toggleTodo 没有撤销入口，这些误触无法挽回。完成切换的唯一入口就是下面的勾选框。
    */
    <div className="flex items-center gap-2.5 py-2 px-0">
      {/* 勾选框：18×18 视觉，24×24 命中区 */}
      <button
        type="button"
        role="checkbox"
        aria-checked={todo.completed}
        aria-label={todo.completed ? `标记未完成：${todo.text}` : `标记完成：${todo.text}`}
        title={todo.completed ? '标记未完成' : '标记完成'}
        className="flex items-center justify-center shrink-0 w-6 h-6 -my-[3px] rounded cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
        style={{ outlineColor: 'var(--accent)' }}
        onClick={(e) => {
          e.stopPropagation()
          onToggle(todo.id)
        }}
      >
        <span
          className="flex items-center justify-center"
          style={{
            width: 18,
            height: 18,
            borderRadius: 4,
            backgroundColor: todo.completed ? ACCENT : 'var(--bg-surface)',
            border: todo.completed ? 'none' : '1.5px solid var(--border-strong)',
          }}
        >
          {todo.completed && <Check size={12} color="#fff" />}
        </span>
      </button>

      {/* 文字：只读展示（删除 / 编辑等条目级操作都在工具区的详细管理页做） */}
      <span
        className="flex-1 min-w-0 truncate text-[13px] select-text"
        style={{
          color: todo.completed ? 'var(--text-muted)' : 'var(--text-primary)',
          textDecoration: todo.completed ? 'line-through' : 'none',
          fontFamily: 'Inter',
        }}
        title={todo.text}
      >
        {todo.text}
      </span>

      {/* 截止时间 */}
      {todo.deadline ? (
        <span className="flex items-center gap-1 shrink-0 select-none">
          <Calendar size={11} color={overdue ? 'var(--danger)' : 'var(--text-secondary)'} />
          <span
            className="text-[11px]"
            style={{ color: overdue ? 'var(--danger)' : 'var(--text-secondary)' }}
          >
            {formatDeadline(todo.deadline)}
          </span>
        </span>
      ) : null}
    </div>
  )
}
