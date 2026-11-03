/**
 * 待办数据类型定义
 */

/** 单条待办 */
export interface Todo {
  /** 唯一标识 */
  id: string
  /** 待办内容 */
  text: string
  /** 是否完成 */
  completed: boolean
  /** 截止时间（ISO 格式 "YYYY-MM-DD"，或旧版自由文本），可选 */
  deadline?: string
  /** 截止时间戳（毫秒），从 deadline 派生，用于排序 */
  deadlineTs?: number
  /** 创建时间戳 */
  createdAt: number
}

/** 筛选类型 */
export type FilterType = 'all' | 'active' | 'completed'

/** 编辑待办时可修改的字段（局部更新） */
export type TodoPatch = Partial<Pick<Todo, 'text' | 'deadline' | 'deadlineTs'>>

/** useTodo Hook 返回值 */
export interface UseTodoReturn {
  /** 当前待办列表（已筛选） */
  todos: Todo[]
  /** 完整待办列表（未筛选） */
  allTodos: Todo[]
  /** 添加待办 */
  addTodo: (text: string, deadline?: string) => void
  /** 切换完成状态 */
  toggleTodo: (id: string) => void
  /** 局部编辑待办（text 会被 trim，空则忽略；带 deadline 时同步重算 deadlineTs） */
  updateTodo: (id: string, patch: TodoPatch) => void
  /** 删除待办，返回被删掉的那条（供"撤销"使用） */
  deleteTodo: (id: string) => Todo | undefined
  /** 撤销单条删除（按 id 去重插回） */
  restoreTodo: (todo: Todo) => void
  /** 清除所有已完成，返回被清掉的列表（供"撤销"使用） */
  clearCompleted: () => Todo[]
  /** 撤销批量清理（按 id 去重插回） */
  restoreTodos: (todos: Todo[]) => void
  /** 当前筛选 */
  filter: FilterType
  /** 设置筛选 */
  setFilter: (filter: FilterType) => void
  /** 统计数据 */
  stats: { total: number; completed: number; active: number }
  /** 跨天 / 窗口重新可见时自增，供 UI 作为依赖触发逾期重算 */
  todayTick: number
  /** 是否逾期（基于 utils.isTodoOverdue） */
  isOverdue: (todo: Todo) => boolean
}
