/**
 * 城市定位 Hook
 *
 * 方案：ip-api.com 获取坐标 → 和风天气 GeoAPI 反查区级 LocationID
 * ip-api.com 免费、无需 Key，但只返回市级坐标
 * 和风天气 GeoAPI 用坐标反查可精确到区/街道级 LocationID
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import type { CityInfo, UseLocationSearchReturn } from './types'
import { httpGetJson } from '../../core/http-client'
import { QWEATHER_KEY_PLACEHOLDER } from '../settings/secrets'
import { QWEATHER_API_HOST, GEO_API_HOST } from './config'

/** 从设置读取 API Host（Key 不在这里，由 Rust 侧注入占位符） */
function getApiHost(): string {
  try {
    const stored = localStorage.getItem('infoboard-settings')
    if (stored) {
      const parsed = JSON.parse(stored)
      return parsed.weatherApiHost || QWEATHER_API_HOST
    }
  } catch {
    /* 忽略 */
  }
  return QWEATHER_API_HOST
}

/**
 * 解析 GeoAPI Host
 * - 和风新版自定义域名（*.qweatherapi.com）：天气与 Geo 同一 Host
 * - 旧版固定域名：devapi/api.qweather.com → geoapi.qweather.com
 */
function resolveGeoHost(apiHost: string): string {
  const h = apiHost.toLowerCase()
  if (h.includes('geoapi')) return apiHost
  // 新控制台自定义 API Host
  if (h.includes('qweatherapi.com')) return apiHost
  // 旧版公共域名
  if (h.includes('qweather.com') || h.includes('heweather.net')) {
    return GEO_API_HOST
  }
  // 其它自定义 host：默认与天气同域
  return apiHost
}

/**
 * 用和风天气 GeoAPI 通过坐标反查地区（精确到区/街道）
 * 端点：GET /geo/v2/city/lookup?location={lon},{lat}
 */
async function reverseGeocode(lat: number, lon: number): Promise<CityInfo | null> {
  const host = getApiHost()
  console.log('[天气插件] GeoAPI 反查配置:', { host, lat, lon })
  if (!host) {
    console.warn('[天气插件] GeoAPI 缺少 host')
    return null
  }

  try {
    const geoHost = resolveGeoHost(host)
    const url = `https://${geoHost}/geo/v2/city/lookup?location=${lon.toFixed(2)},${lat.toFixed(2)}&key=${QWEATHER_KEY_PLACEHOLDER}&lang=zh&number=1`
    console.log('[天气插件] GeoAPI 请求:', url, 'geoHost=', geoHost)
    // Geo 接口 host 通常是 geoapi.qweather.com
    const data = await httpGetJson<{ code: string; location?: Array<Record<string, string>> }>(url)
    console.log('[天气插件] GeoAPI 响应数据:', JSON.stringify(data).slice(0, 300))

    if (data.code !== '200' || !data.location?.length) {
      console.warn('[天气插件] GeoAPI 业务错误或无结果:', data.code)
      return null
    }

    const loc = data.location[0]
    console.log('[天气插件] GeoAPI 反查成功:', loc.name, loc.adm2, loc.id)
    // 显示名：区名 · 市名（如 中原 · 郑州）
    const displayName =
      loc.adm2 && loc.name && loc.adm2 !== loc.name
        ? `${loc.name} · ${loc.adm2}`
        : loc.name || loc.adm2 || '未知地点'
    return {
      locationId: loc.id,
      name: displayName,
      adm2: loc.adm2,
      adm1: loc.adm1,
      country: loc.country,
      lon: loc.lon,
      lat: loc.lat,
    }
  } catch (err) {
    console.error('[天气插件] GeoAPI 反查异常:', err)
    return null
  }
}

/**
 * 城市定位 Hook
 */
export function useLocationSearch(): UseLocationSearchReturn & {
  autoLocate: () => Promise<void>
} {
  const [keyword, setKeyword] = useState('')
  const [results, setResults] = useState<CityInfo[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  /**
   * 卸载时清理防抖定时器与在途请求。
   *
   * 原先只 clearTimeout 在 `search()` 内部，组件卸载后 300ms 的定时器仍会触发，
   * 在已卸载组件上 setState，并在窗口关闭途中白白发一个请求。
   */
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      if (abortRef.current) {
        abortRef.current.abort()
        abortRef.current = null
      }
    }
  }, [])

  /**
   * 请求浏览器 GPS 精确定位（需要用户授权）
   * 成功返回 { lat, lon }，失败返回 null
   */
  const requestGPS = useCallback((): Promise<{ lat: number; lon: number } | null> => {
    return new Promise((resolve) => {
      if (!navigator.geolocation) {
        console.log('[天气插件] 浏览器不支持 GPS 定位')
        return resolve(null)
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          console.log('[天气插件] GPS 定位成功:', pos.coords.latitude, pos.coords.longitude)
          resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude })
        },
        (err) => {
          console.log('[天气插件] GPS 定位失败 (code=' + err.code + '):', err.message)
          resolve(null)
        },
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
      )
    })
  }, [])

  /**
   * 自动定位：浏览器GPS → IP定位fallback → 和风GeoAPI反查
   */
  const autoLocate = useCallback(async () => {
    setSearching(true)
    setSearchError(null)

    try {
      // 第 1 步：尝试浏览器 GPS 精确定位
      let lat: number, lon: number
      const gps = await requestGPS()

      if (gps) {
        lat = gps.lat
        lon = gps.lon
        console.log('[天气插件] 使用 GPS 坐标:', lat, lon)
      } else {
        // GPS 失败，回退到 IP 定位
        const ipData = await window.electronAPI.geolocate()
        console.log('[天气插件] IP 定位结果:', JSON.stringify(ipData))
        if (!ipData) throw new Error('IP 定位失败: 无结果')
        if ('error' in ipData && ipData.error) {
          throw new Error(
            `IP 定位失败: ${'reason' in ipData ? ipData.reason || 'unknown' : 'unknown'}`
          )
        }
        if ('lat' in ipData && typeof ipData.lat === 'number') {
          lat = ipData.lat
          lon = ipData.lon
        } else if ('latitude' in ipData && typeof ipData.latitude === 'number') {
          lat = ipData.latitude
          lon = ipData.longitude
        } else {
          throw new Error('IP 定位失败: 坐标格式无效')
        }
        console.log('[天气插件] 使用 IP 坐标:', lat, lon)
      }

      // 第 2 步：用坐标反查和风天气 GeoAPI（精确到区）
      const geoResult = await reverseGeocode(lat, lon)

      if (geoResult) {
        // GeoAPI 成功：返回区级精度
        setResults([geoResult])
        setKeyword(geoResult.name)
      } else {
        // GeoAPI 失败：直接用坐标
        const fallback: CityInfo = {
          locationId: '',
          name: `${lat.toFixed(2)},${lon.toFixed(2)}`,
          lat: String(lat),
          lon: String(lon),
        }
        setResults([fallback])
        setKeyword(fallback.name)
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '自动定位失败'
      setSearchError(msg)
      console.error('[天气插件] 自动定位失败:', err)
    } finally {
      setSearching(false)
    }
  }, [])

  /**
   * 文字搜索（和风天气 GeoAPI，带 300ms 防抖）
   */
  const search = useCallback((query: string) => {
    if (timerRef.current) clearTimeout(timerRef.current)

    if (!query.trim()) {
      setResults([])
      setSearchError(null)
      return
    }

    if (query.trim().length < 1) return

    timerRef.current = setTimeout(async () => {
      if (abortRef.current) abortRef.current.abort()
      const controller = new AbortController()
      abortRef.current = controller

      setSearching(true)
      setSearchError(null)

      try {
        const geoHost = resolveGeoHost(getApiHost())
        const url = `https://${geoHost}/geo/v2/city/lookup?location=${encodeURIComponent(query.trim())}&key=${QWEATHER_KEY_PLACEHOLDER}&lang=zh&number=8`
        console.log('[天气插件] 城市搜索:', url)
        const data = await httpGetJson<{
          code: string
          location?: Array<Record<string, string>>
        }>(url, controller.signal)

        if (data.code !== '200') {
          console.warn('[天气插件] GeoAPI 返回:', data.code)
          setResults([])
          return
        }

        type GeoLoc = {
          id?: string
          name?: string
          adm2?: string
          adm1?: string
          country?: string
          lon?: string
          lat?: string
        }
        const locations = (data.location || []) as GeoLoc[]
        const cities: CityInfo[] = locations.map((loc) => ({
          locationId: loc.id ?? '',
          name: loc.name ?? '',
          adm2: loc.adm2 ?? '',
          adm1: loc.adm1 ?? '',
          country: loc.country ?? '',
          lon: loc.lon ?? '',
          lat: loc.lat ?? '',
        }))

        setResults(cities)
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === 'AbortError') return
        console.warn('[天气插件] 城市搜索失败:', err)
        setResults([])
      } finally {
        setSearching(false)
      }
    }, 300)
  }, [])

  const clearResults = useCallback(() => {
    setResults([])
    setSearchError(null)
    setKeyword('')
  }, [])

  return {
    keyword,
    setKeyword,
    results,
    searching,
    searchError,
    search,
    clearResults,
    autoLocate,
  }
}
