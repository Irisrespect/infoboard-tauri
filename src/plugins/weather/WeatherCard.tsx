/**
 * 天气卡片组件
 *
 * 完全按照 Pencil 设计稿还原：
 * - 大图标带圆形背景（$accent-light + $accent 图标色）
 * - 所有图标使用主题色 accent
 * - 4 列详情网格（湿度/风速/能见度/紫外线）
 * - Toast 刷新反馈
 * - 逐时预报 + 3 日预报
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import type { PluginComponentProps } from '../../core/types'
import type { WeatherData, ForecastDay, HourlyForecast, CityInfo } from './types'
import { useWeather } from './useWeather'
import { useLocationSearch } from './useLocationSearch'
import { WeatherIcon } from './WeatherIcon'
import { useThemeColors } from '../../hooks/useThemeColors'
import { withAlpha } from '../../utils/themeColor'
import { formatUvIndex } from './display'

// ─── 主题色（模块级，由 WeatherCard 主组件在每次渲染时更新）───
let ACCENT = '#DA7756'

// ─── Toast ───

interface ToastState {
  message: string
  type: 'success' | 'error'
}

/**
 * 天气卡片主组件
 */
export function WeatherCard({ manifest, expanded }: PluginComponentProps) {
  const { data, loading, error, refresh, city, setCity, isOffline } = useWeather()
  const { accent } = useThemeColors()
  // 更新模块级主题色，供子组件使用
  ACCENT = accent
  const [toast, setToast] = useState<ToastState | null>(null)
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const showToast = useCallback((message: string, type: 'success' | 'error') => {
    setToast({ message, type })
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    toastTimerRef.current = setTimeout(() => setToast(null), 2000)
  }, [])

  const handleRefresh = useCallback(async () => {
    // 等真实结果再提示：refresh() 现在返回是否成功
    // （原先 refresh() 不返回 Promise，setTimeout 无条件弹"已刷新"，
    //   失败时也会显示成功）
    const ok = await refresh()
    showToast(ok ? '✅ 天气数据已刷新' : '❌ 刷新失败，请检查网络', ok ? 'success' : 'error')
  }, [refresh, showToast])

  const prevErrorRef = useRef<string | null>(null)
  useEffect(() => {
    if (error && error !== prevErrorRef.current && data) {
      showToast(`❌ ${error}`, 'error')
    }
    prevErrorRef.current = error
  }, [error, data, showToast])

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    }
  }, [])

  if (loading && !data) return <LoadingState />
  if (error && !data) return <ErrorState message={error} onRetry={handleRefresh} />

  if (data) {
    return (
      <div className="relative">
        {/* 折叠摘要：始终可见 */}
        <CompactView data={data} isOffline={isOffline} />

        {/* 展开详情：grid 行高动画 0fr ↔ 1fr */}
        <div
          className="transition-[grid-template-rows] duration-500 ease-[cubic-bezier(0.4,0,0.2,1)]"
          style={{
            display: 'grid',
            gridTemplateRows: expanded ? '1fr' : '0fr',
          }}
        >
          <div className="overflow-hidden min-h-0">
            <ExpandedView
              data={data}
              city={city}
              setCity={setCity}
              onRefresh={handleRefresh}
              isOffline={isOffline}
            />
          </div>
        </div>

        {/* Toast 通知 */}
        {toast && (
          <div className="absolute bottom-0 left-0 right-0 flex justify-center z-10">
            <div
              className={`px-3 py-1.5 rounded-lg text-xs font-medium shadow-lg ${
                toast.type === 'success' ? 'bg-green-500/90 text-white' : 'bg-red-500/90 text-white'
              }`}
            >
              {toast.message}
            </div>
          </div>
        )}
      </div>
    )
  }

  return <EmptyState onRetry={handleRefresh} />
}

// ─── 折叠视图 ───

function CompactView({ data, isOffline }: { data: WeatherData; isOffline: boolean }) {
  return (
    <div className="flex items-center gap-3">
      {/* 图标带圆形背景 */}
      <div
        className="flex items-center justify-center w-10 h-10 rounded-full"
        style={{ backgroundColor: withAlpha(ACCENT, 0.08) }}
      >
        <WeatherIcon name={data.icon} size={20} color={ACCENT} />
      </div>
      <div className="flex flex-col">
        <span
          className="text-2xl font-bold"
          style={{ fontFamily: 'Geist', color: 'var(--text-primary)' }}
        >
          {data.temperature}°
        </span>
        <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
          {data.city} · {data.description}
        </span>
      </div>
      {isOffline && <span className="text-[10px] text-amber-500 ml-auto">📡 离线</span>}
    </div>
  )
}

// ─── 展开视图（按 Pencil 设计稿精确还原）───

function ExpandedView({
  data,
  city,
  setCity,
  onRefresh,
  isOffline,
}: {
  data: WeatherData
  city: string
  setCity: (info: CityInfo) => void
  onRefresh: () => void
  isOffline: boolean
}) {
  const { results, searching, autoLocate, clearResults } = useLocationSearch()

  // 自动定位完成后，自动选择结果
  useEffect(() => {
    if (results.length === 1 && results[0].name) {
      setCity(results[0])
      clearResults()
    }
  }, [results, setCity, clearResults])

  const handleAutoLocate = (e: React.MouseEvent) => {
    e.stopPropagation()
    autoLocate()
  }

  return (
    <div className="flex flex-col gap-3.5">
      {/* 顶部：城市 + 自动定位 + 更新时间 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <WeatherIcon name="compass" size={14} color={ACCENT} />
          <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            {city}
          </span>
          {/* 自动定位按钮 */}
          <button
            className="flex items-center justify-center w-5 h-5 rounded-full transition-opacity hover:opacity-80"
            style={{ backgroundColor: withAlpha(ACCENT, 0.08) }}
            onClick={handleAutoLocate}
            title="自动定位"
          >
            {searching ? (
              <div
                className="w-2.5 h-2.5 border rounded-full animate-spin"
                style={{ borderColor: withAlpha(ACCENT, 0.18), borderTopColor: ACCENT }}
              />
            ) : (
              <WeatherIcon name="compass" size={10} color={ACCENT} />
            )}
          </button>
        </div>
        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          {isOffline
            ? '📡 离线'
            : new Date(data.updatedAt).toLocaleTimeString('zh-CN', {
                hour: '2-digit',
                minute: '2-digit',
              }) + ' 更新'}
        </span>
      </div>

      {/* 主体：温度 + 图标 */}
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-1">
          <span
            style={{
              fontFamily: 'Geist',
              fontSize: '52px',
              fontWeight: 700,
              lineHeight: 1,
              color: 'var(--text-primary)',
            }}
          >
            {data.temperature}°
          </span>
          <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            {data.description}
          </span>
        </div>
        {/* 大图标：圆形背景 + accent 色图标 */}
        <div
          className="flex items-center justify-center w-20 h-20 rounded-full"
          style={{ backgroundColor: withAlpha(ACCENT, 0.08) }}
        >
          <WeatherIcon name={data.icon} size={40} color={ACCENT} />
        </div>
      </div>

      {/* 详情网格：4 列 */}
      <DetailGrid data={data} />

      {/* 逐时预报 */}
      {data.hourly && data.hourly.length > 0 && <HourlySection hourly={data.hourly} />}

      {/* 3 日预报 */}
      {data.forecast.length > 0 && <ForecastSection forecast={data.forecast} />}

      {/* 刷新按钮 */}
      <div className="flex justify-end">
        <button
          className="px-2.5 py-1 rounded-md text-[11px] transition-colors hover:opacity-80"
          style={{ color: ACCENT, backgroundColor: withAlpha(ACCENT, 0.06) }}
          onClick={(e) => {
            e.stopPropagation()
            onRefresh()
          }}
        >
          刷新数据
        </button>
      </div>
    </div>
  )
}

// ─── 详情网格（4 列，按 Pencil 设计）───

function DetailGrid({ data }: { data: WeatherData }) {
  const uvText = formatUvIndex(data.uvIndex)
  const items = [
    { label: '湿度', value: `${data.humidity}%`, icon: 'droplets' },
    { label: '风速', value: `${data.windSpeed} km/h`, icon: 'wind' },
    { label: '能见度', value: `${data.visibility} km`, icon: 'eye' },
    // 只有紫外线可能是文案而非数字（缺数据时显示「暂无」），单独标记以缩小字号
    { label: '紫外线', value: uvText, icon: 'sun', isText: uvText === '暂无' },
  ]

  return (
    <div className="grid grid-cols-4 gap-2">
      {items.map((item) => (
        <div
          key={item.label}
          className="flex flex-col items-center gap-1 p-2.5 rounded-lg"
          style={{ backgroundColor: 'var(--bg-main)' }}
        >
          <WeatherIcon name={item.icon} size={14} color={ACCENT} />
          <span
            className={item.isText ? 'text-[11px] font-medium' : 'text-sm font-semibold'}
            style={{
              fontFamily: 'Geist',
              color: item.isText ? 'var(--text-muted)' : 'var(--text-primary)',
            }}
          >
            {item.value}
          </span>
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {item.label}
          </span>
        </div>
      ))}
    </div>
  )
}

// ─── 逐时预报 ───

function HourlySection({ hourly }: { hourly: HourlyForecast[] }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span
        className="text-[11px] font-semibold tracking-wider"
        style={{ color: 'var(--text-muted)' }}
      >
        逐时预报
      </span>
      <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
        {hourly.slice(0, 12).map((h, i) => (
          <div
            key={i}
            className="flex flex-col items-center gap-1 min-w-[48px] px-2 py-2 rounded-lg"
            style={{ backgroundColor: 'var(--bg-main)' }}
          >
            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
              {h.time}
            </span>
            <WeatherIcon name={h.icon} size={18} color={ACCENT} />
            <span
              className="text-xs font-semibold"
              style={{ fontFamily: 'Geist', color: 'var(--text-primary)' }}
            >
              {h.temp}°
            </span>
            {h.pop > 0 && (
              <span className="text-[9px]" style={{ color: ACCENT }}>
                {h.pop}%
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── 3 日预报（按 Pencil 设计：横向 3 列卡片）───

function ForecastSection({ forecast }: { forecast: ForecastDay[] }) {
  const labels = ['今天', '明天', '后天']
  return (
    <div className="flex flex-col gap-1.5">
      <span
        className="text-[11px] font-semibold tracking-wider"
        style={{ color: 'var(--text-muted)' }}
      >
        未来天气
      </span>
      <div className="grid grid-cols-3 gap-2">
        {forecast.map((day, i) => (
          <div
            key={day.date}
            className="flex flex-col items-center gap-1.5 py-2.5 px-2 rounded-lg"
            style={{ backgroundColor: 'var(--bg-main)' }}
          >
            <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
              {labels[i] || day.date}
            </span>
            <WeatherIcon name={day.icon} size={20} color={ACCENT} />
            <span
              className="text-[13px] font-semibold"
              style={{ fontFamily: 'Geist', color: 'var(--text-primary)' }}
            >
              {day.tempMax}° / {day.tempMin}°
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── 状态组件 ───

function LoadingState() {
  return (
    <div className="flex items-center justify-center py-6">
      <div className="flex flex-col items-center gap-2">
        <div
          className="w-6 h-6 border-2 rounded-full animate-spin"
          style={{ borderColor: withAlpha(ACCENT, 0.18), borderTopColor: ACCENT }}
        />
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
          加载天气数据...
        </span>
      </div>
    </div>
  )
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-2 py-4">
      <WeatherIcon name="alert" size={32} color={ACCENT} />
      <span className="text-xs text-center" style={{ color: 'var(--text-muted)' }}>
        {message}
      </span>
      <button
        className="px-3 py-1 text-xs rounded-lg transition-opacity hover:opacity-80"
        style={{ color: ACCENT, backgroundColor: withAlpha(ACCENT, 0.06) }}
        onClick={(e) => {
          e.stopPropagation()
          onRetry()
        }}
      >
        重试
      </button>
    </div>
  )
}

function EmptyState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-2 py-4">
      <WeatherIcon name="cloud-sun" size={32} color={ACCENT} />
      <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
        暂无天气数据
      </span>
      <button
        className="px-3 py-1 text-xs rounded-lg transition-opacity hover:opacity-80"
        style={{ color: ACCENT, backgroundColor: withAlpha(ACCENT, 0.06) }}
        onClick={(e) => {
          e.stopPropagation()
          onRetry()
        }}
      >
        获取天气
      </button>
    </div>
  )
}
