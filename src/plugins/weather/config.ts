/**
 * 天气插件配置常量（和风天气 API）
 *
 * API Key 不再放在前端：它存在 Windows 凭据管理器里，
 * 请求 URL 里用 `QWEATHER_KEY_PLACEHOLDER` 占位，
 * 由 Rust 侧（core/http_proxy.rs）在发请求前替换。
 *
 * 和风天气控制台：https://console.qweather.com
 */

/** 和风天气 API Host（免费版默认 devapi.qweather.com，付费版 api.qweather.com） */
export const QWEATHER_API_HOST = 'devapi.qweather.com'

/** 和风天气 GeoAPI Host（城市搜索） */
export const GEO_API_HOST = 'geoapi.qweather.com'

/** 默认地区 LocationID（北京 = 101010100） */
export const DEFAULT_LOCATION_ID = '101010100'

/** 默认城市名（仅用于显示） */
export const DEFAULT_CITY_NAME = '北京'

/** 缓存时长（30 分钟） */
export const CACHE_DURATION = 30 * 60 * 1000

/** 缓存键名 */
export const CACHE_KEY = 'weather-data'

/** 城市配置键名 */
export const CITY_KEY = 'weather-city'

/** 刷新间隔（30 分钟） */
export const REFRESH_INTERVAL = 30 * 60 * 1000
