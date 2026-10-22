/**
 * 小牛翻译 — Tauri command invoke 封装（宿主侧）
 *
 * 这个文件原来在 `plugins/translate/bridge.ts`。翻译插件改成**外部插件**
 * （`plugins/translate/`）后，内置插件目录被腾空，但设置面板里的「小牛翻译 API」
 * 配置区仍然要写同一份配置（`niutrans.json` + Windows 凭据管理器），
 * 所以把这层传输封装留在核心里，供设置面板复用。
 *
 * 外部插件不能 import 这里的任何东西（白名单只有 react / react-dom /
 * `@tauri-apps/api/core`），它直接 invoke 同名命令 —— 两边写的是同一份存储，
 * 不存在"两套配置"。
 */

import { invoke } from '@tauri-apps/api/core'

/** 小牛翻译返回的译文 */
export interface TranslateResult {
  text: string
  from: string
  to: string
}

/** 小牛翻译配置（后端只回掩码，不回明文） */
export interface TranslateConfig {
  has_key: boolean
  app_id: string
  api_key_mask: string
}

/** 把 Tauri invoke 错误转成可读字符串（常为 string，不是 Error） */
export function formatInvokeError(err: unknown): string {
  if (err instanceof Error) return err.message || String(err)
  if (typeof err === 'string') return err
  if (err && typeof err === 'object') {
    const o = err as Record<string, unknown>
    if (typeof o.message === 'string') return o.message
    try {
      return JSON.stringify(err)
    } catch {
      return String(err)
    }
  }
  return String(err ?? '未知错误')
}

/**
 * 翻译文本
 * @param text 原文
 * @param targetLang 目标语言（如 zh / en）
 * @param fromLang 源语言，默认 auto
 */
export async function translate(
  text: string,
  targetLang: string,
  fromLang = 'auto'
): Promise<TranslateResult> {
  try {
    return await invoke<TranslateResult>('niutrans_translate', {
      text,
      from: fromLang,
      to: targetLang,
    })
  } catch (e) {
    throw new Error(formatInvokeError(e))
  }
}

/** 写入 API Key（空串 = 删除；明文只进凭据管理器，不进前端存储） */
export async function setApiKey(key: string): Promise<void> {
  await invoke('niutrans_set_api_key', { key })
}

/** 写入 App ID（签名版 Key 需要） */
export async function setAppId(id: string): Promise<void> {
  await invoke('niutrans_set_app_id', { appId: id })
}

/** 是否已配置 API Key */
export async function hasApiKey(): Promise<boolean> {
  return await invoke<boolean>('niutrans_has_api_key')
}

/** 读取配置（App ID / Key 均为掩码） */
export async function getConfig(): Promise<TranslateConfig> {
  return await invoke<TranslateConfig>('niutrans_get_config')
}

/** 累计已翻译字符数 */
export async function getCharCount(): Promise<number> {
  return await invoke<number>('niutrans_get_char_count')
}
