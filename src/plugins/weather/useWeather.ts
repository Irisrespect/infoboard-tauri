/**
 * 天气数据逻辑 Hook（和风天气 API）
 *
 * 负责：
 * 1. 调用和风天气 API 获取实时天气和 3 天预报
 * 2. localStorage 缓存（30 分钟过期）
 * 3. 定时刷新（30 分钟间隔）
 * 4. 错误处理 + 离线检测
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import type {
  WeatherData,
  ForecastDay,
  HourlyForecast,
  CityInfo,
  UseWeatherReturn,
  QWeatherNowResponse,
  QWeatherDailyResponse,
  QWeatherHourlyResponse,
} from './types'
import { httpGetJson } from '../../core/http-client'
import { QWEATHER_KEY_PLACEHOLDER } from '../settings/secrets'
import {
  QWEATHER_API_HOST,
  DEFAULT_LOCATION_ID,
  DEFAULT_CITY_NAME,
  CACHE_DURATION,
  CACHE_KEY,
  CITY_KEY,
  REFRESH_INTERVAL,
} from './config'

/**
 * 和风天气图标代码 → emoji 映射
 *
 * 图标代码文档：https://dev.qweather.com/docs/resource/icons/
 */
function getWeatherEmoji(iconCode: string): string {
  const code = parseInt(iconCode, 10)
  const iconMap: Record<number, string> = {
    100: '☀️', // 晴
    101: '⛅', // 多云
    102: '⛅', // 少云
    103: '⛅', // 晴间多云
    104: '☁️', // 阴
    150: '🌙', // 晴（夜间）
    151: '⛅', // 多云（夜间）
    153: '⛅', // 晴间多云（夜间）
    300: '🌧️', // 阵雨
    301: '🌧️', // 强阵雨
    302: '⛈️', // 雷阵雨
    303: '⛈️', // 强雷阵雨
    304: '⛈️', // 雷阵雨伴有冰雹
    305: '🌧️', // 小雨
    306: '🌧️', // 中雨
    307: '🌧️', // 大雨
    308: '🌧️', // 极端降雨
    309: '🌦️', // 毛毛雨
    310: '🌧️', // 暴雨
    311: '🌧️', // 大暴雨
    312: '🌧️', // 特大暴雨
    313: '🌧️', // 冻雨
    314: '🌧️', // 小到中雨
    315: '🌧️', // 中到大雨
    316: '🌧️', // 大到暴雨
    317: '🌧️', // 暴雨到大暴雨
    318: '🌧️', // 大暴雨到特大暴雨
    350: '🌧️', // 阵雨（夜间）
    399: '🌧️', // 雨
    400: '❄️', // 小雪
    401: '❄️', // 中雪
    402: '❄️', // 大雪
    403: '❄️', // 暴雪
    404: '🌨️', // 雨夹雪
    405: '🌨️', // 雨夹雪
    406: '🌨️', // 阵雨夹雪
    407: '🌨️', // 阵雪
    408: '❄️', // 小到中雪
    409: '❄️', // 中到大雪
    410: '❄️', // 大到暴雪
    456: '🌨️', // 阵雨夹雪（夜间）
    457: '🌨️', // 阵雪（夜间）
    499: '❄️', // 雪
    500: '🌫️', // 薄雾
    501: '🌫️', // 雾
    502: '🌫️', // 霾
    503: '🌫️', // 扬沙
    504: '🌫️', // 浮尘
    507: '🌫️', // 沙尘暴
    508: '🌫️', // 强沙尘暴
    509: '🌫️', // 浓雾
    510: '🌫️', // 强浓雾
    511: '🌫️', // 霾
    512: '🌫️', // 中度霾
    513: '🌫️', // 重度霾
    514: '🌫️', // 严重霾
    515: '🌫️', // 大雾
    900: '🌡️', // 热
    901: '🥶', // 冷
    999: '❓', // 未知
  }
  return iconMap[code] || '🌤️'
}

/**
 * 将星期几转为中文
 */
function getDayLabel(dateStr: string): string {
  const date = new Date(dateStr)
  const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  return days[date.getDay()]
}

/**
 * 读取天气 API Host（Key 不在前端，见下方 buildUrl）
 */
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
 * 构建和风天气 API URL
 * 支持 LocationID 或经纬度坐标
 *
 * Key 用占位符，由 Rust 侧发请求前替换（前端不持有明文 Key）。
 */
function buildUrl(path: string, location: string): string {
  const host = getApiHost()
  return `https://${host}${path}?location=${location}&key=${QWEATHER_KEY_PLACEHOLDER}&lang=zh`
}

/**
 * 从 CityInfo 中获取 location 参数
 * 有 LocationID 用 ID，否则用经纬度坐标
 */
function getLocationParam(city: CityInfo): string {
  if (city.locationId) return city.locationId
  if (city.lat && city.lon) return `${city.lon},${city.lat}`
  return DEFAULT_LOCATION_ID
}

/**
 * 将 API 响应转换为内部数据结构
 */
function transformWeatherData(
  nowRes: QWeatherNowResponse,
  dailyRes: QWeatherDailyResponse,
  hourlyRes: QWeatherHourlyResponse | null,
  cityName: string
): WeatherData {
  const now = nowRes.now

  return {
    city: cityName,
    temperature: parseInt(now.temp, 10) || 0,
    feelsLike: parseInt(now.feelsLike, 10) || 0,
    humidity: parseInt(now.humidity, 10) || 0,
    windSpeed: parseInt(now.windSpeed, 10) || 0,
    windDir: now.windDir,
    description: now.text,
    icon: now.icon,
    pressure: parseInt(now.pressure, 10) || 0,
    visibility: parseInt(now.vis, 10) || 0,
    // 紫外线指数只在 3 日预报里（now 没有这个字段），取今天那条
    uvIndex: dailyRes.daily?.[0]?.uvIndex ?? '',
    forecast: dailyRes.daily.slice(0, 3).map((day): ForecastDay => ({
      date: getDayLabel(day.fxDate),
      tempMax: parseInt(day.tempMax, 10) || 0,
      tempMin: parseInt(day.tempMin, 10) || 0,
      description: day.textDay,
      icon: day.iconDay,
    })),
    hourly: hourlyRes
      ? hourlyRes.hourly.slice(0, 24).map((h): HourlyForecast => ({
          time: new Date(h.fxTime).toLocaleTimeString('zh-CN', {
            hour: '2-digit',
            minute: '2-digit',
          }),
          temp: parseInt(h.temp, 10) || 0,
          icon: h.icon,
          description: h.text,
          pop: parseInt(h.pop, 10) || 0,
        }))
      : [],
    updatedAt: Date.now(),
  }
}

/**
 * 从 localStorage 读取城市配置（向后兼容旧格式）
 * 校验条件：有 name，且有 locationId 或有经纬度坐标
 * 这样 GeoAPI 失败时的 fallback（locationId 为空但有坐标）也能通过验证
 */
function loadCityConfig(): CityInfo {
  try {
    const stored = localStorage.getItem(CITY_KEY)
    if (stored) {
      const parsed = JSON.parse(stored)
      if (parsed.name && (parsed.locationId || (parsed.lat && parsed.lon))) {
        return parsed as CityInfo
      }
    }
  } catch {
    // 解析失败使用默认值
  }
  return { locationId: DEFAULT_LOCATION_ID, name: DEFAULT_CITY_NAME }
}

/**
 * 天气数据 Hook
 *
 * @example
 * ```tsx
 * function WeatherCard() {
 *   const { data, loading, error, refresh, city, setCity, isOffline } = useWeather()
 *
 *   if (loading) return <Loading />
 *   if (error) return <Error message={error} onRetry={refresh} />
 *
 *   return <div>{data?.temperature}°C</div>
 * }
 * ```
 */
export function useWeather(): UseWeatherReturn {
  const [cityConfig, setCityConfig] = useState(loadCityConfig)

  console.log('[天气] useWeather 初始化, cityConfig:', JSON.stringify(cityConfig))

  const [data, setData] = useState<WeatherData | null>(() => {
    try {
      const cached = localStorage.getItem(CACHE_KEY)
      if (!cached) {
        console.log('[天气] 无缓存数据')
        return null
      }
      const parsed = JSON.parse(cached)
      if (Date.now() - parsed.updatedAt < CACHE_DURATION) {
        console.log(
          '[天气] 使用缓存数据, 更新时间:',
          new Date(parsed.updatedAt).toLocaleTimeString('zh-CN')
        )
        return parsed
      }
      console.log('[天气] 缓存已过期')
      return null
    } catch {
      return null
    }
  })

  const [loading, setLoading] = useState<boolean>(!data)
  const [error, setError] = useState<string | null>(null)
  const [isOffline, setIsOffline] = useState<boolean>(
    typeof navigator !== 'undefined' ? !navigator.onLine : false
  )
  const abortControllerRef = useRef<AbortController | null>(null)
  // 用 ref 追踪最新 data，避免将 data 加入 useCallback 依赖
  const dataRef = useRef(data)
  dataRef.current = data

  /**
   * 保存到缓存
   */
  const saveToCache = useCallback((weatherData: WeatherData) => {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(weatherData))
    } catch (err) {
      console.warn('[天气插件] 缓存保存失败:', err)
    }
  }, [])

  /**
   * 获取天气数据
   *
   * @returns 是否真的刷新成功（供"刷新"按钮提示用；失败原因已写进 error 状态）
   */
  const fetchWeather = useCallback(
    async (config?: CityInfo): Promise<boolean> => {
      const city = config || cityConfig
      const locationParam = getLocationParam(city)
      const cityName = city.name

      console.log('[天气] ========== fetchWeather 开始 ==========')
      console.log('[天气] 城市:', cityName, 'locationParam:', locationParam)

      // Key 由 Rust 侧在发请求前注入；没配置时那边会返回明确错误，
      // 这里不再自己判断（前端也读不到 Key）

      // 离线时跳过请求
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        console.log('[天气] 检测到离线状态，跳过请求')
        setIsOffline(true)
        if (!dataRef.current) {
          try {
            const cached = localStorage.getItem(CACHE_KEY)
            if (cached) setData(JSON.parse(cached))
          } catch {
            /* 缓存读取失败 */
          }
        }
        setLoading(false)
        return false
      }
      setIsOffline(false)

      // 取消上一次请求
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }
      const controller = new AbortController()
      abortControllerRef.current = controller

      setLoading(true)
      setError(null)

      try {
        console.log('[天气] 并行发起 3 个 API 请求...')
        // 并行请求实时天气、3 天预报；逐时预报在付费版才有，单独处理
        const urls = [
          buildUrl('/v7/weather/now', locationParam),
          buildUrl('/v7/weather/3d', locationParam),
          buildUrl('/v7/weather/24h', locationParam),
        ]
        // URL 里只有占位符，可以安全打印
        console.log('[天气] now URL:', urls[0])
        console.log('[天气] 3d URL:', urls[1])

        // 经 Rust 代理请求（打包后 WebView 直连常失败 → status 0）
        const [nowRes, dailyRes, hourlyRes] = await Promise.allSettled([
          httpGetJson<QWeatherNowResponse>(urls[0], controller.signal),
          httpGetJson<QWeatherDailyResponse>(urls[1], controller.signal),
          httpGetJson<QWeatherHourlyResponse>(urls[2], controller.signal),
        ])

        console.log(
          '[天气] now 状态:',
          nowRes.status,
          nowRes.status === 'fulfilled' ? 'ok' : String((nowRes as PromiseRejectedResult).reason)
        )
        console.log(
          '[天气] daily 状态:',
          dailyRes.status,
          dailyRes.status === 'fulfilled'
            ? 'ok'
            : String((dailyRes as PromiseRejectedResult).reason)
        )
        console.log(
          '[天气] hourly 状态:',
          hourlyRes.status,
          hourlyRes.status === 'fulfilled'
            ? 'ok'
            : String((hourlyRes as PromiseRejectedResult).reason)
        )

        // allSettled 会吞掉取消：被新请求取代时直接交给外层 catch 的 AbortError 分支，
        // 否则会把"已取消"误报成"实时天气请求失败"
        for (const r of [nowRes, dailyRes, hourlyRes]) {
          if (r.status === 'rejected' && r.reason instanceof DOMException && r.reason.name === 'AbortError') {
            throw r.reason
          }
        }

        if (nowRes.status !== 'fulfilled') {
          // 未配置 Key 时 Rust 侧会直接返回"未配置和风天气 API Key（设置 → 天气 API）"
          const reason = String(nowRes.reason || '')
          throw new Error(`实时天气请求失败: ${reason || '网络错误'}`)
        }
        if (dailyRes.status !== 'fulfilled') {
          const reason = String(dailyRes.reason || '')
          throw new Error(`预报数据请求失败: ${reason || '网络错误'}`)
        }

        const nowData: QWeatherNowResponse = nowRes.value
        const dailyData: QWeatherDailyResponse = dailyRes.value
        console.log(
          '[天气] nowData.code:',
          nowData.code,
          'nowData.now:',
          JSON.stringify(nowData.now).slice(0, 120)
        )
        console.log(
          '[天气] dailyData.code:',
          dailyData.code,
          'dailyData.daily 条数:',
          dailyData.daily?.length
        )
        let hourlyData: QWeatherHourlyResponse | null = null

        if (hourlyRes.status === 'fulfilled') {
          hourlyData = hourlyRes.value
        }

        // 检查和风天气业务状态码
        if (nowData.code !== '200') {
          const errorMap: Record<string, string> = {
            '204': '请求成功，但你查询的地区暂时没有你需要的数据',
            '400': '请求错误，可能参数有误',
            '401': '认证失败，请检查 API Key 和 API Host',
            '402': '超过访问次数或余额不足',
            '403': '无访问权限，请在控制台检查',
            '404': '查询的地区不存在',
            '429': '超过限定的访问次数',
            '500': '和风天气服务异常',
          }
          throw new Error(errorMap[nowData.code] || `请求失败 (${nowData.code})`)
        }

        // 转换数据
        const weatherData = transformWeatherData(nowData, dailyData, hourlyData, cityName)
        console.log(
          '[天气] 转换成功: temp=',
          weatherData.temperature,
          'city=',
          weatherData.city,
          'hourly条数=',
          weatherData.hourly.length
        )

        setData(weatherData)
        saveToCache(weatherData)
        setError(null)
        return true
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          console.log('[天气] 请求被取消 (AbortError)')
          return false
        }

        const errorMessage = err instanceof Error ? err.message : '获取天气数据失败'
        console.error('[天气] fetchWeather 异常:', errorMessage, err)
        setError(errorMessage)

        // 离线时尝试返回缓存数据
        if (!dataRef.current) {
          try {
            const cached = localStorage.getItem(CACHE_KEY)
            if (cached) setData(JSON.parse(cached))
          } catch {
            /* 缓存读取失败 */
          }
        }
        return false
      } finally {
        setLoading(false)
      }
    },
    [cityConfig, saveToCache]
  )

  /** 刷新数据（把真实结果返回给调用方，"刷新"按钮据此提示成功/失败） */
  const refresh = useCallback(() => fetchWeather(), [fetchWeather])

  /** 切换城市（支持区/街道级） */
  const setCity = useCallback(
    (cityInfo: CityInfo) => {
      setCityConfig(cityInfo)
      try {
        localStorage.setItem(CITY_KEY, JSON.stringify(cityInfo))
      } catch {
        /* 存储失败忽略 */
      }
      fetchWeather(cityInfo)
    },
    [fetchWeather]
  )

  // 初始化时获取数据
  useEffect(() => {
    fetchWeather()
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // 定时刷新
  useEffect(() => {
    const timer = setInterval(() => {
      fetchWeather()
    }, REFRESH_INTERVAL)
    return () => clearInterval(timer)
  }, [fetchWeather])

  // 监听网络状态变化
  useEffect(() => {
    const handleOnline = () => {
      setIsOffline(false)
      fetchWeather()
    }
    const handleOffline = () => setIsOffline(true)

    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [fetchWeather])

  // 监听设置变更（天气城市切换 / 天气 Key 重新配置）
  useEffect(() => {
    const handleSettingsChanged = (e: Event) => {
      const detail = (e as CustomEvent).detail
      // 单个字段变更或批量变更中包含 weatherCity
      const isWeatherCityChange =
        detail?.key === 'weatherCity' || (detail?.key === 'batch' && detail.patch?.weatherCity)

      // 设置面板保存了新的天气 API Key（存在凭据管理器里，前端只收到通知）
      if (detail?.key === 'weatherApiKey') {
        fetchWeather()
        return
      }

      if (isWeatherCityChange) {
        const locationId = detail.key === 'batch' ? detail.patch.weatherCity : detail.value

        if (typeof locationId !== 'string') return

        // 从 localStorage 读取城市名
        let cityName = locationId
        try {
          const stored = localStorage.getItem('infoboard-settings')
          if (stored) {
            const parsed = JSON.parse(stored)
            if (parsed.weatherCityName) cityName = parsed.weatherCityName
          }
        } catch {
          /* 忽略 */
        }
        setCity({ locationId, name: cityName })
      }
    }

    window.addEventListener('settings:changed', handleSettingsChanged)
    return () => window.removeEventListener('settings:changed', handleSettingsChanged)
  }, [setCity, fetchWeather])

  // 显示名称：区 · 城市（如 "海淀 · 北京"），或直接城市名
  const displayName =
    cityConfig.adm2 && cityConfig.name !== cityConfig.adm2
      ? `${cityConfig.name} · ${cityConfig.adm2}`
      : cityConfig.name

  return {
    data,
    loading,
    error,
    refresh,
    city: displayName,
    cityInfo: cityConfig,
    setCity,
    isOffline,
  }
}
