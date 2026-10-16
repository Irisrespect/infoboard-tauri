/**
 * 统一 HTTP GET：打包环境强制走 Rust 代理，暴露真实错误
 */

import { invoke } from '@tauri-apps/api/core'

function isTauri(): boolean {
  return (
    typeof window !== 'undefined' &&
    // Tauri 2
    ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
  )
}

function formatInvokeError(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError')
}

/**
 * 让一个不可中断的 Promise（如 Tauri invoke）支持 AbortSignal：
 * signal 触发时立刻以 AbortError 拒绝，之后到达的旧结果被丢弃。
 */
function withAbort<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return task()
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    task().then(
      (v) => {
        signal.removeEventListener('abort', onAbort)
        resolve(v)
      },
      (e) => {
        signal.removeEventListener('abort', onAbort)
        reject(e)
      }
    )
  })
}

export async function httpGetJson<T = unknown>(url: string, signal?: AbortSignal): Promise<T> {
  if (isTauri()) {
    try {
      const text = await withAbort(() => invoke<string>('http_proxy_get', { url }), signal)
      try {
        return JSON.parse(text) as T
      } catch (e) {
        const head = text.slice(0, 40).replace(/[^\x20-\x7e]/g, '.')
        throw new Error(
          `JSON 解析失败: ${e instanceof Error ? e.message : String(e)} (body头: ${head})`
        )
      }
    } catch (e) {
      // 取消必须原样抛出，调用方靠 AbortError 识别并忽略过期请求
      if (e instanceof DOMException && e.name === 'AbortError') throw e
      // 不回退 fetch：打包 WebView 几乎一定失败，且会掩盖真实原因
      throw new Error(formatInvokeError(e))
    }
  }

  const res = await fetch(url, { signal })
  if (!res.ok) {
    throw new Error(`请求失败 (${res.status})`)
  }
  return (await res.json()) as T
}

export async function httpGetText(url: string, signal?: AbortSignal): Promise<string> {
  if (isTauri()) {
    try {
      return await withAbort(() => invoke<string>('http_proxy_get', { url }), signal)
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw e
      throw new Error(formatInvokeError(e))
    }
  }
  const res = await fetch(url, { signal })
  if (!res.ok) {
    throw new Error(`请求失败 (${res.status})`)
  }
  return await res.text()
}
