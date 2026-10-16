/**
 * 插件事件总线 — 松耦合通知机制
 *
 * 用途：插件之间的单向通知（emit → on）
 * 不适用：请求/响应模式、数据查询、方法调用
 *
 * 示例：
 * ✅ eventBus.emit('notification:new', { sender, subject })
 * ❌ const result = await eventBus.request('weather:getCurrent')  // 不要用事件总线做 RPC
 *
 * 设计原则：
 * 1. 松耦合：发送方不需要知道接收方是谁
 * 2. 单向通知：只有 emit → on，没有 request → response
 * 3. 自动清理：通过 owner 标识防止内存泄漏
 */

// ─── 事件类型定义 ───

/** 插件事件基础结构 */
export interface PluginEvent {
  /** 事件类型，如 'notification:new', 'todo:added' */
  type: string

  /** 来源插件 ID */
  source: string

  /** 事件数据（类型由具体事件定义） */
  payload: unknown

  /** 事件时间戳 */
  timestamp: number
}

/** 事件处理器类型 */
type EventHandler = (event: PluginEvent) => void

/** 监听器结构（包含 owner 标识） */
interface Listener {
  /** 唯一标识 */
  id: string

  /** 组件/hook 标识（用于自动清理） */
  owner: string

  /** 事件处理器 */
  handler: EventHandler
}

// ─── 工具函数 ───

/** 生成唯一 ID */
let listenerIdCounter = 0
function generateId(): string {
  return `listener_${++listenerIdCounter}_${Date.now()}`
}

// ─── EventBus 类 ───

class EventBus {
  /** 事件监听器映射：type → listeners[] */
  private listeners = new Map<string, Listener[]>()

  /**
   * 订阅事件
   *
   * @param type - 事件类型
   * @param handler - 事件处理器
   * @param owner - 组件/hook 标识（用于自动清理）
   * @returns 清理函数（调用后自动取消订阅）
   *
   * @example
   * ```typescript
   * // 在 hook 或组件中使用
   * useEffect(() => {
   *   const cleanup = eventBus.on('notification:new', handleNotification, 'useNotifications')
   *   return cleanup  // 组件卸载时自动清理
   * }, [])
   * ```
   */
  on(type: string, handler: EventHandler, owner: string): () => void {
    const listener: Listener = {
      id: generateId(),
      owner,
      handler,
    }

    // 获取或创建该类型的监听器列表
    const typeListeners = this.listeners.get(type) || []
    typeListeners.push(listener)
    this.listeners.set(type, typeListeners)

    // 返回清理函数
    return () => this.off(type, listener.id)
  }

  /**
   * 取消订阅（通过监听器 ID）
   *
   * @param type - 事件类型
   * @param listenerId - 监听器 ID
   */
  off(type: string, listenerId: string): void {
    const typeListeners = this.listeners.get(type)
    if (!typeListeners) return

    // 过滤掉指定 ID 的监听器
    const filtered = typeListeners.filter((l) => l.id !== listenerId)

    if (filtered.length === 0) {
      // 如果没有监听器了，删除该类型的映射
      this.listeners.delete(type)
    } else {
      this.listeners.set(type, filtered)
    }
  }

  /**
   * 清理指定 owner 的所有监听器（组件卸载时调用）
   *
   * @param owner - 组件/hook 标识
   *
   * @example
   * ```typescript
   * // 组件卸载时清理所有该组件的监听器
   * useEffect(() => {
   *   return () => eventBus.cleanup('useNotifications')
   * }, [])
   * ```
   */
  cleanup(owner: string): void {
    // 先收集所有需要清理的 type，避免在迭代 Map 时修改它
    const typesToClean: string[] = []

    for (const [type, typeListeners] of this.listeners.entries()) {
      const hasOwnerListeners = typeListeners.some((l) => l.owner === owner)
      if (hasOwnerListeners) {
        typesToClean.push(type)
      }
    }

    // 执行清理
    for (const type of typesToClean) {
      const typeListeners = this.listeners.get(type)
      if (!typeListeners) continue

      const filtered = typeListeners.filter((l) => l.owner !== owner)

      if (filtered.length === 0) {
        this.listeners.delete(type)
      } else {
        this.listeners.set(type, filtered)
      }
    }
  }

  /**
   * 发射事件
   *
   * @param type - 事件类型
   * @param payload - 事件数据
   * @param source - 来源插件 ID
   *
   * @example
   * ```typescript
   * eventBus.emit('island:visibility', { visible: true }, 'dynamic-island')
   * ```
   */
  emit(type: string, payload: unknown, source: string): void {
    console.log(
      `[事件] ${type} ← ${source}`,
      typeof payload === 'object' ? JSON.stringify(payload) : payload
    )
    const typeListeners = this.listeners.get(type)
    if (!typeListeners || typeListeners.length === 0) return

    // 构造事件对象
    const event: PluginEvent = {
      type,
      source,
      payload,
      timestamp: Date.now(),
    }

    // 通知所有监听器（使用副本避免迭代时修改）
    const listenersSnapshot = [...typeListeners]
    for (const listener of listenersSnapshot) {
      try {
        listener.handler(event)
      } catch (error) {
        console.error(`[EventBus] 监听器执行失败 (type: ${type}, owner: ${listener.owner}):`, error)
      }
    }
  }

  /**
   * 获取指定事件类型的监听器数量（调试用）
   *
   * @param type - 事件类型（可选，不传则返回总数）
   * @returns 监听器数量
   */
  getListenerCount(type?: string): number {
    if (type) {
      return this.listeners.get(type)?.length || 0
    }

    let total = 0
    for (const typeListeners of this.listeners.values()) {
      total += typeListeners.length
    }
    return total
  }

  /**
   * 清空所有监听器（谨慎使用，通常用于测试）
   */
  clearAll(): void {
    this.listeners.clear()
  }
}

// ─── 导出单例 ───

/**
 * 全局事件总线单例
 *
 * 所有插件共享同一个事件总线实例
 */
export const eventBus = new EventBus()
