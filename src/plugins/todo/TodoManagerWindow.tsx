/**
 * 待办详细管理 —— **独立窗口页**（`index.html#/todo`）
 *
 * UI 与交互从外置插件 `plugins/todo-manager/index.tsx` **原样搬过来**（内联样式一个类名都没改）：
 * 行内编辑、IME 全保护、删除按钮同位置冷却、删除/清理的撤销 toast、空状态、损坏态只读。
 *
 * ## 和插件版的区别只有"数据层"
 * 插件版与宿主是两个独立的模块实例（import 不到宿主），所以自带了一份解析 / 排序 / 逾期实现，
 * 并靠 `window` 上的自定义事件同步。这里跑在同一份代码里，一律改用宿主实现，不再复制：
 *
 * | 插件版（`plugins/todo-manager`）        | 这里（宿主）                                    |
 * | --------------------------------------- | ----------------------------------------------- |
 * | `loadSnapshot` / `saveSnapshot`         | `useTodoStore`（hydrate + 各 mutator，同步落盘） |
 * | `parseDeadlineToDayEnd`（拷贝实现）     | `utils.parseDeadlineToDayEnd`（校验用户输入）    |
 * | `parseDeadlinePatch`（拷贝实现）        | store 内部用 `utils.parseDeadlinePatch` 归一化  |
 * | `compareTodosByDeadline`（拷贝实现）    | `utils.compareTodosByDeadline`                  |
 * | `isTodoOverdue`（拷贝实现）             | `utils.isTodoOverdue`                           |
 * | `formatDeadline`（本地私有）            | `utils.formatDeadline`（卡片与窗口共用一份）    |
 * | `todo:data-changed` 自定义事件          | localStorage `storage` 事件（store 里注册）     |
 * | `commit` / `applyTodos` / `generateId`  | 删掉 —— store 的 mutator 就是唯一写入口        |
 *
 * ## 为什么样式是内联的
 * 这份代码原来在外置插件里（`tailwind.config.ts` 的 content 不含 `plugins/`，
 * 类名写了也不生成）。搬进 `src/` 之后**保留原样**：观感已经在真机上逐项核过，
 * 换成 Tailwind 类名等于重画一遍，收益为零、风险不小。
 *
 * ## 两处刻意的"反直觉"实现（沿用插件版，别"优化"掉）
 * 1. **行上不挂 onClick**：点行 = 切换完成会带来两类误操作 —— 拖选文字松手补发 click 被静默勾掉；
 *    双击时第一击置完成立刻沉底重排，第二击落到顶替上来的另一行又勾一条。
 *    切换完成的唯一入口是勾选框。
 * 2. **删除按钮 350ms 同位置冷却**：删掉一行后列表立刻重排，上一次点击的位置换成了另一条待办，
 *    连点会误删两条。冷却只看鼠标（`detail === 0` 的键盘触发不参与，否则键盘用户连按会被吞）。
 */

import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FilterType, Todo } from './types'
import { useTodoStore, TODO_BACKEND } from './store'
import {
  compareTodosByDeadline,
  formatDeadline,
  isTodoOverdue,
  nextLocalMidnightDelay,
  parseDeadlineToDayEnd,
} from './utils'
import { loadSettings } from '../settings/settingsStorage'

// ─────────────────────────── 常量 ───────────────────────────

/** 删除按钮的同位置冷却时长（毫秒） */
const DELETE_COOLDOWN_MS = 350
/** 删除按钮冷却的坐标容差（像素） */
const DELETE_COOLDOWN_RADIUS = 24

const FILTER_OPTIONS: { key: FilterType; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'active', label: '进行中' },
  { key: 'completed', label: '已完成' },
]

// ─────────────────────── toast / 存储状态 ───────────────────────

interface ToastPayload {
  message: string
  color?: string
  /** 带 action 时宿主 toast 默认停留 8 秒（撤销离不开手点） */
  action?: { label: string; onClick: () => void }
}

/** toast 出口：`window.toastAPI` → `toast-show` 事件 → 本窗口的 `<GlobalToast />` */
function showToast(payload: ToastPayload): void {
  if (typeof window === 'undefined') return
  window.toastAPI?.show?.(payload)
}

/**
 * 把主窗口选的主题应用到本窗口
 *
 * 独立窗口不挂 `<App />`，也就没有设置面板那套 `useSettings()` 副作用 ——
 * 不补这一步，深色主题用户点开待办会看到一个通白的窗。
 */
function applyWindowTheme(): void {
  try {
    const theme = loadSettings().theme
    const resolved =
      theme === 'system'
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light'
        : theme
    document.documentElement.setAttribute('data-theme', resolved)
  } catch {
    // 读不到设置就用 `:root` 的默认（浅色），功能不受影响
  }
  // `body` 在 globals.css 里是 `var(--bg-main)` —— 粉紫主题下那是**全透明**（主窗要透桌面），
  // 深色/亮色下又是不透明实色。本窗口是二级窗口，统一刷成**半透明面板底色** `--bg-window`（alpha 0.92）。
  // 写成 var() 而不是取具体色值：切主题时 `data-theme` 一变它就跟着变。
  // 实测踩过的坑：如果这里和组件根节点各画一层 0.92，叠加后是 1-(1-0.92)² = 0.9936
  // （CDP 截图底色 alpha=253/255，真机上桌面只透出约 0.8%），"半透明"就名存实亡。
  // 所以面板底色**只允许一层**：由 body 画，组件根节点保持 transparent。
  document.body.style.backgroundColor = 'var(--bg-window)'
}

/**
 * 输入法正在拼字时的键盘事件判定
 *
 * 中文/日文输入法里 Enter 是"确认候选词"，不是"提交"。`isComposing` 是标准属性；
 * 少数输入法只在 keydown 上给出 keyCode 229，所以两个都判。
 */
function isComposingEvent(event: ReactKeyboardEvent<HTMLInputElement>): boolean {
  const native = event.nativeEvent as KeyboardEvent
  return Boolean(native?.isComposing) || native?.keyCode === 229
}

// ─────────────────────────── 图标（内联 SVG） ───────────────────────────

interface IconProps {
  size?: number
}

/** 统一描边图标外壳：24 网格 / 描边 / 圆头圆角，颜色跟随 currentColor */
function Icon({ size = 12, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

function IconCheck({ size = 11 }: IconProps) {
  return (
    <Icon size={size}>
      <path d="M20 6 9 17l-5-5" />
    </Icon>
  )
}

function IconPlus({ size = 12 }: IconProps) {
  return (
    <Icon size={size}>
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </Icon>
  )
}

function IconCalendar({ size = 11 }: IconProps) {
  return (
    <Icon size={size}>
      <path d="M8 2v4" />
      <path d="M16 2v4" />
      <rect width="18" height="18" x="3" y="4" rx="2" />
      <path d="M3 10h18" />
    </Icon>
  )
}

function IconPencil({ size = 13 }: IconProps) {
  return (
    <Icon size={size}>
      <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
      <path d="m15 5 4 4" />
    </Icon>
  )
}

function IconTrash({ size = 13 }: IconProps) {
  return (
    <Icon size={size}>
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </Icon>
  )
}

// ─────────────────────────── 共用样式 ───────────────────────────

/** 操作按钮：24×24 命中区，内容居中，无边框 */
const ICON_BUTTON_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  width: 24,
  height: 24,
  padding: 0,
  border: 'none',
  borderRadius: 6,
  background: 'transparent',
  cursor: 'pointer',
}

/** 文本输入框（添加区 / 编辑态共用观感） */
const TEXT_INPUT_STYLE: CSSProperties = {
  minWidth: 0,
  height: 30,
  padding: '0 8px',
  fontSize: 12.5,
  fontFamily: 'Inter',
  color: 'var(--text-primary)',
  background: 'var(--bg-surface)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 8,
  outline: 'none',
}

// ─────────────────────────── 行内编辑器 ───────────────────────────

interface TodoEditorProps {
  /** 进入编辑态时的原文（只作为初始值，之后由输入自己维护） */
  initialText: string
  onSave: (text: string) => void
  onCancel: () => void
}

/**
 * 行内编辑框
 *
 * `aria-label` 是**固定名**「编辑待办」，不拼 todo.text：拼进去的话每编辑一条
 * 无障碍名就换一个，屏幕阅读器和自动化测试都得重新认元素。
 *
 * Enter 保存 / Esc 取消 / blur 保存（点别处等于确认，符合列表行内编辑的直觉）。
 */
function TodoEditor({ initialText, onSave, onCancel }: TodoEditorProps) {
  const [text, setText] = useState(initialText)
  const inputRef = useRef<HTMLInputElement | null>(null)
  /**
   * 一次性结算闩锁：Esc 取消会让本组件卸载，浏览器随后可能补一个 blur，
   * 没有闩锁就会出现"取消了又被 blur 保存回去"。
   */
  const settledRef = useRef(false)

  useEffect(() => {
    const element = inputRef.current
    if (!element) return
    element.focus({ preventScroll: true })
    // 全选：进来就能整体重写，而不是先手动删干净
    element.select()
  }, [])

  const settle = (save: boolean) => {
    if (settledRef.current) return
    settledRef.current = true
    if (save) onSave(text)
    else onCancel()
  }

  return (
    <input
      ref={inputRef}
      type="text"
      value={text}
      aria-label="编辑待办"
      onChange={(event) => setText(event.target.value)}
      onKeyDown={(event) => {
        // 输入法拼字中的 Enter / Esc 都属于输入法自己，不能当提交/取消
        if (isComposingEvent(event)) return
        event.stopPropagation()
        if (event.key === 'Enter') {
          event.preventDefault()
          settle(true)
        } else if (event.key === 'Escape') {
          event.preventDefault()
          settle(false)
        }
      }}
      onBlur={() => settle(true)}
      style={{ ...TEXT_INPUT_STYLE, flex: 1 }}
    />
  )
}

// ─────────────────────────── 列表行 ───────────────────────────

interface TodoRowProps {
  todo: Todo
  /** 逾期（由父组件用 isTodoOverdue + 统一的"现在"算出） */
  overdue: boolean
  /** 读取失败时禁用所有写操作 */
  disabled: boolean
  editing: boolean
  onToggle: (id: string) => void
  onStartEdit: (id: string) => void
  onSaveEdit: (id: string, text: string) => void
  onCancelEdit: () => void
  onDelete: (todo: Todo, event: ReactMouseEvent<HTMLButtonElement>) => void
}

/**
 * 一行待办
 *
 * 整行**没有 onClick**（见文件头"两处反直觉实现"）：想勾选只能点左边的勾选框。
 */
function TodoRow({
  todo,
  overdue,
  disabled,
  editing,
  onToggle,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onDelete,
}: TodoRowProps) {
  /**
   * 内联 style 写不了 `:hover`，所以"悬停点亮操作按钮"靠状态位实现：
   * 操作按钮常驻 `opacity: 0.4`（不能是完全隐藏 —— 隐藏了用户根本不知道行上有按钮），
   * 鼠标进入本行、或键盘把焦点移进来时变成 1。
   */
  const [hovered, setHovered] = useState(false)

  return (
    <div
      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 2px', minHeight: 30 }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* 勾选框：18×18 视觉、24×24 命中区，role=checkbox 让键盘/读屏能操作 */}
      <button
        type="button"
        role="checkbox"
        aria-checked={todo.completed}
        aria-label={todo.completed ? `标记未完成：${todo.text}` : `标记完成：${todo.text}`}
        title={todo.completed ? '标记未完成' : '标记完成'}
        disabled={disabled}
        onClick={() => onToggle(todo.id)}
        style={{ ...ICON_BUTTON_STYLE, cursor: disabled ? 'not-allowed' : 'pointer' }}
      >
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 18,
            height: 18,
            borderRadius: 4,
            color: '#fff',
            background: todo.completed ? 'var(--accent)' : 'transparent',
            border: todo.completed ? '1.5px solid var(--accent)' : '1.5px solid var(--border-strong)',
          }}
        >
          {todo.completed ? <IconCheck size={12} /> : null}
        </span>
      </button>

      {/* 文本：单行截断，title 里带全文（截断了也能看到） */}
      {editing ? (
        <TodoEditor
          initialText={todo.text}
          onSave={(text) => onSaveEdit(todo.id, text)}
          onCancel={onCancelEdit}
        />
      ) : (
        <span
          title={todo.text}
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 12.5,
            fontFamily: 'Inter',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            userSelect: 'text',
            color: todo.completed ? 'var(--text-muted)' : 'var(--text-primary)',
            textDecoration: todo.completed ? 'line-through' : 'none',
          }}
        >
          {todo.text}
        </span>
      )}

      {/* 截止日期：逾期变红 */}
      {todo.deadline ? (
        <span
          title={overdue ? '已逾期' : '截止日期'}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 3,
            flexShrink: 0,
            fontSize: 11,
            color: overdue ? 'var(--danger)' : 'var(--text-secondary)',
          }}
        >
          <IconCalendar size={11} />
          <span>{formatDeadline(todo.deadline)}</span>
        </span>
      ) : null}

      {/* 编辑 / 删除：常驻淡显，hover 或聚焦时点亮 */}
      <span
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          flexShrink: 0,
          opacity: hovered ? 1 : 0.4,
          transition: 'opacity .15s ease',
        }}
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
      >
        <button
          type="button"
          aria-label={`编辑：${todo.text}`}
          title="编辑"
          disabled={disabled}
          onClick={() => onStartEdit(todo.id)}
          style={{
            ...ICON_BUTTON_STYLE,
            color: 'var(--text-secondary)',
            cursor: disabled ? 'not-allowed' : 'pointer',
          }}
        >
          <IconPencil size={13} />
        </button>
        <button
          type="button"
          aria-label={`删除：${todo.text}`}
          title="删除"
          disabled={disabled}
          onClick={(event) => onDelete(todo, event)}
          style={{
            ...ICON_BUTTON_STYLE,
            color: 'var(--danger)',
            cursor: disabled ? 'not-allowed' : 'pointer',
          }}
        >
          <IconTrash size={13} />
        </button>
      </span>
    </div>
  )
}

// ─────────────────────────── 主组件 ───────────────────────────

/**
 * 待办详细管理窗口页
 *
 * 不需要 `manifest` prop：它不注册成插件，只是一个独立窗口的根页面。
 */
export function TodoManagerWindow() {
  // ── 数据：宿主的单例 store（读写同一份 `todo-list`） ──
  const todos = useTodoStore((state) => state.todos)
  const hydrate = useTodoStore((state) => state.hydrate)
  const addTodo = useTodoStore((state) => state.addTodo)
  const toggleTodo = useTodoStore((state) => state.toggleTodo)
  const updateTodo = useTodoStore((state) => state.updateTodo)
  const deleteTodo = useTodoStore((state) => state.deleteTodo)
  const restoreTodo = useTodoStore((state) => state.restoreTodo)
  const clearCompleted = useTodoStore((state) => state.clearCompleted)
  const restoreTodos = useTodoStore((state) => state.restoreTodos)

  const [input, setInput] = useState('')
  const [deadlineInput, setDeadlineInput] = useState('')
  /** 筛选是**本窗口自己的**临时状态（不进 store，否则和主窗口卡片互相串台） */
  const [filter, setFilter] = useState<FilterType>('all')
  const [editingId, setEditingId] = useState<string | null>(null)
  /** 读取失败态：数据源坏了就只读，绝不覆盖原文（判定与文案都由 store 统一给） */
  const corrupt = useTodoStore((state) => state.corrupt)
  const dataPath = useTodoStore((state) => state.dataPath)
  /**
   * 数据文件绝对路径（只读横幅里给用户指路用）
   *
   * 异步取，**只在真的进只读态时才问**（正常使用一次 IPC 都不花）：
   * 取不到就保持空串，横幅退化成不含路径的文案 —— 路径是锦上添花，不能因为
   * `todo_data_path` 失败就连"该怎么办"都不显示。
   * `cancelled` 挡住"组件已卸载 / 已恢复可写后迟到的结果"。
   */
  const [dataPathText, setDataPathText] = useState('')
  /** 算逾期用的"现在"：跨天 / 窗口重新可见时更新（见下面的 tick effect） */
  const [nowTs, setNowTs] = useState(() => Date.now())

  /** 上一次删除点击的时间与坐标（350ms 同位置冷却用） */
  const lastDeleteRef = useRef<{ at: number; x: number; y: number } | null>(null)

  const readOnly = corrupt

  // 挂载时读一次盘（store 里幂等；同时懒注册 storage 监听）
  useEffect(() => {
    hydrate()
  }, [hydrate])

  // 主题跟随主窗口（独立窗口没有设置面板的副作用，这里自己补一次）
  useEffect(() => {
    applyWindowTheme()
  }, [])

  // 只读时取一次数据文件路径（异步；取不到就退化成不含路径的文案）
  useEffect(() => {
    if (!corrupt || TODO_BACKEND !== 'file' || dataPathText) return
    let cancelled = false
    void dataPath().then(
      (path) => {
        if (!cancelled) setDataPathText(path)
      },
      () => {
        /* 问不出路径：横幅保留不含路径的版本，功能不受影响 */
      }
    )
    return () => {
      cancelled = true
    }
  }, [corrupt, dataPath, dataPathText])

  /**
   * 跨天 tick
   *
   * 逾期判定读的是"现在"，而 React 不会因为时间流逝重渲染 —— 挂一个到次日 0 点 + 1 秒
   * 的定时器（`nextLocalMidnightDelay`），跨过 0 点就把 `nowTs` 推一格；另外窗口重新
   * 聚焦 / 可见时也推一格（睡一晚再打开时定时器可能被系统挂起）。
   */
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined

    const scheduleNextMidnight = () => {
      timer = setTimeout(() => {
        setNowTs(Date.now())
        scheduleNextMidnight()
      }, nextLocalMidnightDelay())
    }
    scheduleNextMidnight()

    const bump = () => setNowTs(Date.now())
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

  /**
   * 另一个窗口把数据改坏了（或改好了）：不用自己监听
   *
   * `corrupt` 现在直接来自 `useTodoStore` —— 文件后端由 store 的 1.5s 轮询刷新，
   * 浏览器兜底由 store 里的 `storage` 监听刷新。本窗口自己写不出坏数据
   * （写的永远是合法 JSON），所以这里既不需要 `storage` 监听，也不需要本地状态。
   */

  const stats = useMemo(() => {
    const total = todos.length
    const completed = todos.filter((todo) => todo.completed).length
    return { total, completed, active: total - completed }
  }, [todos])

  /** 当前筛选下要显示的行（含渲染期算好的逾期标记） */
  const rows = useMemo(() => {
    return todos
      .slice()
      .sort(compareTodosByDeadline)
      .filter((todo) => {
        if (filter === 'active') return !todo.completed
        if (filter === 'completed') return todo.completed
        return true
      })
      .map((todo) => ({ todo, overdue: isTodoOverdue(todo, nowTs) }))
  }, [todos, filter, nowTs])

  /** 添加：Enter 与按钮同一入口 */
  const handleAdd = useCallback(() => {
    if (readOnly) return

    const text = input.trim()
    // 空文本不提交（也不清空，用户可能刚打到一半）
    if (!text) return

    const deadlineText = deadlineInput.trim()

    // 非法日期：提示但不提交、不清空 —— 用户写的日期还在原地等他改
    // （store.addTodo 拿不到有效日期时会"忽略日期照收待办"，这里先拦住，
    //   免得用户以为日期已经生效）
    if (deadlineText && parseDeadlineToDayEnd(deadlineText) === undefined) {
      showToast({
        message: `截止日期无效：${deadlineText}（支持 2026-03-08 或 3月8日）`,
        color: 'var(--danger)',
      })
      return
    }

    addTodo(text, deadlineText || undefined)
    setInput('')
    setDeadlineInput('')
    // 新增后必须让用户看见：停在「已完成」筛选下加完什么都看不到，会以为没成功而重复输入
    setFilter('all')
  }, [addTodo, deadlineInput, input, readOnly])

  const handleAddKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      // 输入法拼字中的 Enter 是在选词，不能提交
      if (isComposingEvent(event)) return
      if (event.key !== 'Enter') return
      event.preventDefault()
      handleAdd()
    },
    [handleAdd]
  )

  const handleToggle = useCallback(
    (id: string) => {
      if (readOnly) return
      toggleTodo(id)
    },
    [readOnly, toggleTodo]
  )

  /**
   * 删除按钮的同位置冷却
   *
   * 删掉一行后列表立刻重排：上一次点击的位置换成了"顶替上来"的另一条待办，
   * 连点第二下就会误删一条用户没打算删的。
   * 键盘触发的 click 没有坐标（`detail === 0`），不参与冷却 —— 键盘用户连按是正常操作。
   */
  const shouldIgnoreDeleteClick = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>): boolean => {
      if (event.detail === 0) return false
      const now = Date.now()
      const last = lastDeleteRef.current
      // 先记账再看：被忽略的点击也会刷新时间戳，连点三下不会"漏掉"第三下
      lastDeleteRef.current = { at: now, x: event.clientX, y: event.clientY }
      if (!last) return false
      return (
        now - last.at < DELETE_COOLDOWN_MS &&
        Math.abs(event.clientX - last.x) < DELETE_COOLDOWN_RADIUS &&
        Math.abs(event.clientY - last.y) < DELETE_COOLDOWN_RADIUS
      )
    },
    []
  )

  const handleDelete = useCallback(
    (todo: Todo, event: ReactMouseEvent<HTMLButtonElement>) => {
      if (readOnly) return
      if (shouldIgnoreDeleteClick(event)) return
      // store 同步返回被删掉的那条（供撤销），删不到就什么都不做
      const removed = deleteTodo(todo.id)
      if (!removed) return
      showToast({
        message: `已删除「${removed.text}」`,
        color: 'var(--danger)',
        action: { label: '撤销', onClick: () => restoreTodo(removed) },
      })
    },
    [deleteTodo, readOnly, restoreTodo, shouldIgnoreDeleteClick]
  )

  const handleClearCompleted = useCallback(() => {
    if (readOnly) return
    const removed = clearCompleted()
    if (removed.length === 0) return
    showToast({
      message: `已清理 ${removed.length} 条已完成`,
      color: 'var(--danger)',
      action: { label: '撤销', onClick: () => restoreTodos(removed) },
    })
  }, [clearCompleted, readOnly, restoreTodos])

  const handleSaveEdit = useCallback(
    (id: string, text: string) => {
      setEditingId(null)
      const trimmed = text.trim()
      // 空文本不保存（不把待办改成空白），直接退出编辑
      if (!trimmed) return
      updateTodo(id, { text: trimmed })
    },
    [updateTodo]
  )

  const handleCancelEdit = useCallback(() => setEditingId(null), [])

  const progressPercent = stats.total > 0 ? (stats.completed / stats.total) * 100 : 0

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        height: '100vh',
        padding: 14,
        overflowY: 'auto',
        fontFamily: 'Inter',
        // 半透明面板底色**只由 body 画**（`applyWindowTheme` 里把 body 刷成 var(--bg-window)）。
        // 这里必须留 transparent：
        //   - 用 var(--bg-main) 的话，深色/亮色下它是不透明实色，会把 body 的半透明面板整个盖死；
        //   - 用 var(--bg-window) 就是两层 0.92 叠加 → 实际 0.9936，桌面透不出来（实测 alpha 253/255）。
        background: 'transparent',
      }}
    >
      {/* 1. 头部：标题 + 完成数徽标 + 进度条 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
          待办事项
        </span>
        <span
          style={{
            marginLeft: 'auto',
            fontSize: 11,
            fontWeight: 600,
            padding: '1px 8px',
            borderRadius: 999,
            color: 'var(--accent)',
            background: 'var(--accent-light)',
          }}
        >
          {stats.completed}/{stats.total} 完成
        </span>
      </div>
      <div
        style={{
          height: 4,
          borderRadius: 999,
          background: 'var(--border-subtle)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            height: '100%',
            width: `${progressPercent}%`,
            borderRadius: 999,
            background: 'var(--accent)',
            transition: 'width .3s ease',
          }}
        />
      </div>

      {/* 8. 读取失败：禁用所有写操作，绝不覆盖原文 */}
      {readOnly ? (
        <div
          style={{
            fontSize: 11,
            lineHeight: 1.6,
            padding: '7px 9px',
            borderRadius: 8,
            color: 'var(--danger)',
            background: 'var(--danger-bg)',
            border: '1px solid var(--danger)',
          }}
        >
          {TODO_BACKEND === 'file' ? (
            <>
              {/* 发布包：数据源是 todo.json。别再让用户去 localStorage 里找东西 —— 那儿什么都没有。 */}
              <div>待办数据文件（todo.json）读取失败，已停止写入以免覆盖原文。</div>
              {dataPathText ? (
                <div style={{ wordBreak: 'break-all', opacity: 0.85 }}>
                  数据文件：{dataPathText}
                </div>
              ) : null}
              <div>可能是被手工编辑或外部程序写坏了，修好就能继续用。</div>
              <div>① 用编辑器修好 JSON，或从备份恢复；</div>
              <div>② 修好不用重开窗口，约 1.5 秒后自动恢复编辑。</div>
            </>
          ) : (
            <div>
              本地待办数据读取失败（localStorage 的 todo-list 不是合法数组），已停止写入以免覆盖原文。
              请先修好原始数据（或恢复 `todo-list.corrupt.*` 备份）后再关掉本窗口重开。
            </div>
          )}
        </div>
      ) : null}

      {/* 2. 添加区：文本 + 日期 + 按钮（Enter 同效，输入法拼字中不提交） */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input
          type="text"
          value={input}
          disabled={readOnly}
          aria-label="新待办内容"
          placeholder="添加新待办..."
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={handleAddKeyDown}
          style={{ ...TEXT_INPUT_STYLE, flex: 1 }}
        />
        <input
          type="text"
          value={deadlineInput}
          disabled={readOnly}
          aria-label="截止日期"
          placeholder="截止（可选）"
          onChange={(event) => setDeadlineInput(event.target.value)}
          onKeyDown={handleAddKeyDown}
          style={{ ...TEXT_INPUT_STYLE, width: 104 }}
        />
        <button
          type="button"
          disabled={readOnly}
          aria-label="添加待办"
          title="添加（Enter）"
          onClick={handleAdd}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 3,
            flexShrink: 0,
            height: 30,
            padding: '0 10px',
            fontSize: 12,
            fontWeight: 600,
            fontFamily: 'Inter',
            border: 'none',
            borderRadius: 8,
            color: '#fff',
            background: 'var(--accent)',
            cursor: readOnly ? 'not-allowed' : 'pointer',
          }}
        >
          <IconPlus size={12} />
          添加
        </button>
      </div>

      {/* 3. 筛选 + 7. 一键清理已完成（仅「已完成」且数量 > 0 时出现） */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {FILTER_OPTIONS.map((option) => {
          const isActive = filter === option.key
          return (
            <button
              key={option.key}
              type="button"
              aria-pressed={isActive}
              onClick={() => setFilter(option.key)}
              style={{
                padding: '3px 10px',
                fontSize: 11.5,
                fontFamily: 'Inter',
                border: 'none',
                borderRadius: 6,
                fontWeight: isActive ? 600 : 400,
                color: isActive ? 'var(--accent)' : 'var(--text-muted)',
                background: isActive ? 'var(--accent-light)' : 'var(--bg-main)',
                cursor: 'pointer',
              }}
            >
              {option.label}
            </button>
          )
        })}
        {filter === 'completed' && stats.completed > 0 ? (
          <button
            type="button"
            disabled={readOnly}
            onClick={handleClearCompleted}
            style={{
              marginLeft: 'auto',
              padding: '3px 10px',
              fontSize: 11.5,
              fontFamily: 'Inter',
              border: 'none',
              borderRadius: 6,
              color: 'var(--danger)',
              background: 'var(--danger-bg)',
              cursor: readOnly ? 'not-allowed' : 'pointer',
            }}
          >
            一键清理
          </button>
        ) : null}
      </div>

      {/* 4/5/6. 列表 */}
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {rows.length === 0 ? (
          <div style={{ padding: '14px 0', textAlign: 'center' }}>
            <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
              {readOnly
                ? '数据读取失败，暂不显示待办'
                : filter === 'all'
                  ? '还没有待办，在上面的输入框里加一条吧'
                  : filter === 'active'
                    ? '没有进行中的待办'
                    : '还没有完成的待办'}
            </span>
          </div>
        ) : (
          rows.map(({ todo, overdue }) => (
            <TodoRow
              key={todo.id}
              todo={todo}
              overdue={overdue}
              disabled={readOnly}
              editing={editingId === todo.id}
              onToggle={handleToggle}
              onStartEdit={setEditingId}
              onSaveEdit={handleSaveEdit}
              onCancelEdit={handleCancelEdit}
              onDelete={handleDelete}
            />
          ))
        )}
      </div>
    </div>
  )
}
