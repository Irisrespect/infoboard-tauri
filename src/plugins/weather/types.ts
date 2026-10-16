/**
 * 天气数据类型定义（和风天气 API）
 *
 * 基于和风天气 API v7 响应结构
 * 文档：https://dev.qweather.com/docs/api/
 */

/** 天气数据（组件使用） */
export interface WeatherData {
  /** 城市名称 */
  city: string
  /** 当前温度（摄氏度） */
  temperature: number
  /** 体感温度（摄氏度） */
  feelsLike: number
  /** 湿度百分比 */
  humidity: number
  /** 风速（km/h） */
  windSpeed: number
  /** 风向（如 "东南风"） */
  windDir: string
  /** 天气描述（中文，如 "多云"） */
  description: string
  /** 天气图标代码（如 "101"） */
  icon: string
  /** 气压（hPa） */
  pressure: number
  /** 能见度（km） */
  visibility: number
  /** 今日紫外线指数（来自 3 日预报的 uvIndex，如 "3"；拿不到时为空串） */
  uvIndex: string
  /** 3 日预报 */
  forecast: ForecastDay[]
  /** 24 小时逐时预报 */
  hourly: HourlyForecast[]
  /** 数据更新时间戳 */
  updatedAt: number
}

/** 预报日数据 */
export interface ForecastDay {
  /** 日期（如 "周一"） */
  date: string
  /** 最高温（摄氏度） */
  tempMax: number
  /** 最低温（摄氏度） */
  tempMin: number
  /** 白天天气描述 */
  description: string
  /** 白天天气图标代码 */
  icon: string
}

/** 逐时预报数据 */
export interface HourlyForecast {
  /** 时间（如 "15:00"） */
  time: string
  /** 温度（摄氏度） */
  temp: number
  /** 天气图标代码 */
  icon: string
  /** 天气描述 */
  description: string
  /** 降水概率（%） */
  pop: number
}

/** useWeather Hook 返回值 */
export interface UseWeatherReturn {
  /** 天气数据 */
  data: WeatherData | null
  /** 加载状态 */
  loading: boolean
  /** 错误信息 */
  error: string | null
  /** 刷新数据。返回是否真的成功（调用方据此提示，别无条件报成功） */
  refresh: () => Promise<boolean>
  /** 当前城市显示名（如 "海淀 · 北京"） */
  city: string
  /** 当前城市详细信息 */
  cityInfo: CityInfo
  /** 设置城市（传入完整 CityInfo） */
  setCity: (cityInfo: CityInfo) => void
  /** 是否离线 */
  isOffline: boolean
}

// ─── 和风天气 API 响应类型 ───

/** 和风天气实时天气响应 */
export interface QWeatherNowResponse {
  code: string
  updateTime: string
  now: {
    obsTime: string
    temp: string
    feelsLike: string
    icon: string
    text: string
    wind360: string
    windDir: string
    windScale: string
    windSpeed: string
    humidity: string
    precip: string
    pressure: string
    vis: string
    cloud: string
    dew: string
  }
}

/** 和风天气每日预报响应 */
export interface QWeatherDailyResponse {
  code: string
  updateTime: string
  daily: Array<{
    fxDate: string
    sunrise: string
    sunset: string
    tempMax: string
    tempMin: string
    iconDay: string
    textDay: string
    iconNight: string
    textNight: string
    windDirDay: string
    windScaleDay: string
    windSpeedDay: string
    humidity: string
    precip: string
    pressure: string
    vis: string
    uvIndex: string
  }>
}

/** 和风天气逐小时预报响应 */
export interface QWeatherHourlyResponse {
  code: string
  updateTime: string
  hourly: Array<{
    fxTime: string
    temp: string
    icon: string
    text: string
    wind360: string
    windDir: string
    windScale: string
    windSpeed: string
    humidity: string
    pop: string
    precip: string
    pressure: string
    cloud: string
    dew: string
  }>
}

/** 城市信息（用于配置和显示） */
export interface CityInfo {
  /** 和风天气 LocationID */
  locationId: string
  /** 地区名称（如 "海淀"、"朝阳"） */
  name: string
  /** 上级城市（如 "北京"） */
  adm2?: string
  /** 省份（如 "北京市"） */
  adm1?: string
  /** 国家（如 "中国"） */
  country?: string
  /** 经度 */
  lon?: string
  /** 纬度 */
  lat?: string
}

/** GeoAPI 城市搜索响应 */
export interface GeoSearchResponse {
  code: string
  location: Array<{
    name: string
    id: string
    lat: string
    lon: string
    adm2: string
    adm1: string
    country: string
    tz: string
    utcOffset: string
    isDst: string
    type: string
    rank: string
    fxLink: string
  }>
}

/** useLocationSearch Hook 返回值 */
export interface UseLocationSearchReturn {
  /** 搜索关键词 */
  keyword: string
  /** 设置搜索关键词 */
  setKeyword: (keyword: string) => void
  /** 搜索结果 */
  results: CityInfo[]
  /** 是否正在搜索 */
  searching: boolean
  /** 搜索错误 */
  searchError: string | null
  /** 执行搜索 */
  search: (query: string) => void
  /** 清空结果 */
  clearResults: () => void
}
