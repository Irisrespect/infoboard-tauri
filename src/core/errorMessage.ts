/**
 * 错误信息格式化（纯函数，便于单测）
 *
 * 为什么需要它：Tauri 的 `invoke` 拒绝时抛的是**字符串**（Rust `Err(String)` 序列化而来），
 * 而 JS 里各种库抛的是 `Error`；直接 `String(e)` / `` `${e}` `` 遇到
 * 既不是 Error 也不是字符串的拒绝值（例如 `{ code, message }` 对象）会渲染成
 * `[object Object]`，用户和排查者都看不到原因。
 */

/** 把任意 catch 到的值转成可读的一行错误信息 */
export function errorMessage(err: unknown): string {
  if (err === null) return 'null'
  if (err === undefined) return 'undefined'

  if (typeof err === 'string') return err

  if (err instanceof Error) {
    // Error 的 message 可能是空串（如 new Error()），退回到 name
    return err.message || err.name || 'Error'
  }

  if (typeof err === 'object') {
    const obj = err as Record<string, unknown>
    // 常见的 Tauri / 网络错误形状：{ message } / { error } / { code, message }
    const message = obj.message ?? obj.error ?? obj.msg
    if (typeof message === 'string' && message) {
      const code = obj.code
      return code === undefined || code === null || code === ''
        ? message
        : `${message} (code=${String(code)})`
    }
    try {
      const json = JSON.stringify(err)
      if (json && json !== '{}') return json
    } catch {
      // 循环引用等：JSON.stringify 抛错，退到下面的字段列表
    }
    // 兜底也绝不能返回 "[object Object]"：至少列出字段名（含循环引用的对象）
    const keys = Object.keys(obj)
    const ctor = (err as { constructor?: { name?: string } }).constructor?.name
    const label = keys.length > 0 ? keys.join(', ') : (ctor ?? 'object')
    return `[无法序列化的错误: ${label}]`
  }

  // number / boolean / bigint / symbol / function
  return String(err)
}
