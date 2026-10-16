/**
 * 切换原生 DevTools。
 *
 * 命令属于 Tauri 的 webview 插件（`plugin:webview|internal_toggle_devtools`），
 * 并且只在 debug 构建（或启用 `devtools` feature）里存在；
 * release 包里调用会失败，此时靠应用内日志台排障，所以失败只记 debug 日志。
 */

import { invoke } from '@tauri-apps/api/core'

export const TOGGLE_DEVTOOLS_COMMAND = 'plugin:webview|internal_toggle_devtools'

export async function toggleNativeDevtools(): Promise<void> {
  try {
    await invoke(TOGGLE_DEVTOOLS_COMMAND)
  } catch (error) {
    console.debug('[DevTools] 原生 DevTools 不可用（release 构建默认不含）:', error)
  }
}
