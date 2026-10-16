/**
 * 凭据（API Key）前端桥接
 *
 * 前端**不持有**明文 Key：只能写入 / 查询是否存在 / 删除，
 * 读取由 Rust 侧在发请求前完成（见 `src-tauri/src/core/secrets.rs`）。
 */

import { invoke } from '@tauri-apps/api/core'

/** 和风天气 Key 的凭据名（与 Rust `core::secrets::NAME_QWEATHER` 一致） */
export const SECRET_NAME_QWEATHER = 'qweather'
/** 小牛翻译 Key 的凭据名（与 Rust `core::secrets::NAME_NIUTRANS` 一致） */
export const SECRET_NAME_NIUTRANS = 'niutrans'

/**
 * 天气请求 URL 里的 Key 占位符。
 * Rust 侧 `core::http_proxy.rs` 的 `QWEATHER_KEY_PLACEHOLDER` 必须与此完全一致，
 * 由 `src/__tests__/secretsContract.test.ts` 校验。
 */
export const QWEATHER_KEY_PLACEHOLDER = '{{QWEATHER_KEY}}'

/** localStorage 里设置项的键名（settingsStorage 也用它） */
const SETTINGS_STORAGE_KEY = 'infoboard-settings'

/** 写入凭据；传空串等于删除 */
export async function secretSet(name: string, value: string): Promise<void> {
  await invoke('secret_set', { name, value })
}

/** 是否已配置（前端永远拿不到明文） */
export async function secretHas(name: string): Promise<boolean> {
  return await invoke<boolean>('secret_has', { name })
}

export async function secretDelete(name: string): Promise<void> {
  await invoke('secret_delete', { name })
}

/** 把设置里的旧状态同步给关心它的组件（useWeather 收到后会立即重新请求） */
export function notifyWeatherKeyChanged(): void {
  window.dispatchEvent(
    new CustomEvent('settings:changed', { detail: { key: 'weatherApiKey' } })
  )
}

/**
 * 看起来像凭据的设置字段名。
 *
 * 当前 Settings 的字段里只有 `weatherApiKey` 会命中（它单独走迁移），
 * 其余命中的都是**已删除功能**遗留下来的明文（例如 MiniMax 用量查询的
 * `minimaxApiKey`）——功能都没了，值直接删掉，不迁移。
 */
const CREDENTIAL_FIELD_PATTERN = /(apikey|api_key|token|secret|password|passwd|credential)/i

/**
 * 启动时清理 localStorage 里的明文凭据：
 *
 * 1. `weatherApiKey`（旧版本存的天气 Key）→ 写入 Windows 凭据管理器 → 从 localStorage 删除；
 *    写入失败时**保留**旧值（不能把用户的 Key 弄丢），只打日志。
 * 2. 其它"看起来是凭据"的字段（已删除功能的残留，如 `minimaxApiKey`）→ 直接删除。
 *
 * @returns 迁移/清理结果摘要（便于日志与测试）
 */
export async function migrateLegacySecrets(): Promise<{
  migratedWeatherKey: boolean
  removedFields: string[]
  keptWeatherKey: boolean
}> {
  const result = { migratedWeatherKey: false, removedFields: [] as string[], keptWeatherKey: false }

  let raw: string | null = null
  try {
    raw = localStorage.getItem(SETTINGS_STORAGE_KEY)
  } catch {
    return result
  }
  if (!raw) return result

  let parsed: Record<string, unknown>
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return result
    parsed = value as Record<string, unknown>
  } catch {
    return result
  }

  let changed = false

  // 1) 天气 Key：迁移到凭据管理器
  const legacyKey = typeof parsed.weatherApiKey === 'string' ? parsed.weatherApiKey.trim() : ''
  if (legacyKey) {
    try {
      await secretSet(SECRET_NAME_QWEATHER, legacyKey)
      delete parsed.weatherApiKey
      changed = true
      result.migratedWeatherKey = true
      console.info('[secrets] 已把天气 API Key 从 localStorage 迁移到 Windows 凭据管理器')
    } catch (err) {
      // 凭据库不可用：保留旧值，下次启动再试
      console.warn('[secrets] 迁移天气 API Key 失败，暂时保留 localStorage 旧值:', err)
      result.keptWeatherKey = true
    }
  } else if ('weatherApiKey' in parsed) {
    delete parsed.weatherApiKey
    changed = true
  }

  // 2) 其它凭据残留：功能已删除，值直接丢弃。
  // weatherApiKey 由第 1 步专门处理：迁移失败时它必须留在原处（用户还没丢 Key），
  // 不能被这里的通用规则顺手删掉。
  for (const field of Object.keys(parsed)) {
    if (field === 'weatherApiKey') continue
    if (CREDENTIAL_FIELD_PATTERN.test(field)) {
      delete parsed[field]
      result.removedFields.push(field)
      changed = true
    }
  }

  if (changed) {
    try {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(parsed))
    } catch {
      /* 忽略：写不进去也不会让应用起不来 */
    }
    if (result.removedFields.length > 0) {
      console.info(
        `[secrets] 已从 localStorage 删除遗留凭据字段: ${result.removedFields.join(', ')}`
      )
    }
  }

  return result
}
