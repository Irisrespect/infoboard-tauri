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
  /** 删除待办 */
  deleteTodo: (id: string) => void
  /** 清除所有已完成 */
  clearCompleted: () => void
  /** 当前筛选 */
  filter: FilterType
  /** 设置筛选 */
  setFilter: (filter: FilterType) => void
  /** 统计数据 */
  stats: { total: number; completed: number; active: number }
}
