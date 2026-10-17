/**
 * 设置面板组件
 *
 * 包含区域：
 * 1. 主题切换（暖橙浅色 / 深色 / 粉紫透明 / 跟随系统）
 * 2. 天气 API 配置
 * 3. 系统设置（开机自启动）
 * 4. 插件管理
 */

import { useCallback, useEffect, useState } from 'react'
import { useSettings } from './useSettings'
import { pluginRegistry } from '../../core/PluginRegistry'
import { reloadPluginSystem } from '../../core/PluginHost'
import { PluginManager } from './PluginManager'
import type { ThemeMode } from './types'
import { THEME_PREVIEWS } from './types'
import * as autostart from '../../core/autostart-bridge'
import * as niutrans from '../translate/bridge'
import {
  SECRET_NAME_QWEATHER,
  notifyWeatherKeyChanged,
  secretHas,
  secretSet,
} from './secrets'

/**
 * 设置面板
 */
export function SettingsPanel() {
  const { settings, updateSettings, togglePlugin } = useSettings()
  const [autoStart, setAutoStart] = useState(false)
  const [niutransAppId, setNiutransAppId] = useState('')
  const [niutransApiKey, setNiutransApiKey] = useState('')
  const [niutransHasKey, setNiutransHasKey] = useState(false)
  const canSaveNiu = !!niutransAppId && (!!niutransApiKey || niutransHasKey)

  // 天气 Key 只存凭据管理器，面板里只显示"是否已配置"
  const [weatherApiKey, setWeatherApiKey] = useState('')
  const [weatherHasKey, setWeatherHasKey] = useState(false)
  const [savingWeatherKey, setSavingWeatherKey] = useState(false)

  // 插件热重载
  const [reloadingPlugins, setReloadingPlugins] = useState(false)
  const [pluginCount, setPluginCount] = useState(() => pluginRegistry.getAllPlugins().length)

  const allPlugins = pluginRegistry.getAllPlugins()

  // 读取小牛翻译配置状态
  useEffect(() => {
    niutrans
      .hasApiKey()
      .then((exists) => {
        setNiutransHasKey(exists)
      })
      .catch(() => {})
  }, [])

  // 读取天气 Key 是否已配置
  useEffect(() => {
    secretHas(SECRET_NAME_QWEATHER)
      .then(setWeatherHasKey)
      .catch(() => {})
  }, [])

  // 从系统读取开机自启动状态
  useEffect(() => {
    autostart
      .isEnabled()
      .then((enabled) => {
        setAutoStart(enabled)
      })
      .catch(() => {
        // 读取失败，默认关闭
      })
  }, [])

  /** 切换开机自启动 */
  const handleAutoStartToggle = useCallback(async () => {
    const next = !autoStart
    setAutoStart(next)
    await autostart.setEnabled(next)
    updateSettings({ autoStart: next })
  }, [autoStart, updateSettings])

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* 主题切换 */}
      <section>
        <SectionTitle>主题</SectionTitle>
        <div className="grid grid-cols-3 gap-2 mt-2">
          {THEME_PREVIEWS.map((preview) => {
            const isActive = settings.theme === preview.id
            return (
              <button
                key={preview.id}
                className="flex flex-col items-center gap-1.5 py-2.5 px-2 rounded-lg transition-all relative"
                style={{
                  backgroundColor: 'var(--bg-surface)',
                  border: isActive ? '2px solid var(--accent)' : '1px solid var(--border-subtle)',
                }}
                onClick={() => updateSettings({ theme: preview.id })}
              >
                {/* 选中对勾 */}
                {isActive && (
                  <span
                    className="absolute top-1 right-1 text-[10px] font-bold"
                    style={{ color: 'var(--accent)' }}
                  >
                    ✓
                  </span>
                )}
                {/* 三色预览条 */}
                <div className="flex gap-0.5 w-full">
                  {preview.colors.map((color, i) => (
                    <div
                      key={i}
                      className="flex-1 h-5 rounded-sm"
                      style={{
                        backgroundColor: color,
                        border: '1px solid rgba(0,0,0,0.08)',
                      }}
                    />
                  ))}
                </div>
                {/* 主题名称 */}
                <span className="text-[11px] font-medium" style={{ color: 'var(--text-primary)' }}>
                  {preview.name}
                </span>
              </button>
            )
          })}
        </div>
        {/* 跟随系统 */}
        <button
          className="w-full py-1.5 mt-2 text-xs font-medium rounded-md transition-all"
          style={
            settings.theme === 'system'
              ? { backgroundColor: 'var(--accent)', color: '#fff' }
              : { backgroundColor: 'var(--bg-surface)', color: 'var(--text-secondary)' }
          }
          onClick={() => updateSettings({ theme: 'system' })}
        >
          跟随系统
        </button>
      </section>

      {/* 天气 API 配置 */}
      <section>
        <SectionTitle>天气 API</SectionTitle>
        <div className="mt-2 flex flex-col gap-2">
          <div>
            <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>
              API Host
            </label>
            <input
              type="text"
              className="input text-xs"
              value={settings.weatherApiHost}
              placeholder="和风天气 API Host"
              onChange={(e) => updateSettings({ weatherApiHost: e.target.value })}
            />
          </div>
          <div>
            <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>
              API Key
            </label>
            <input
              type="password"
              className="input text-xs"
              value={weatherApiKey}
              placeholder={weatherHasKey ? '已配置（输入新密钥可替换）' : '和风天气 API Key'}
              onChange={(e) => setWeatherApiKey(e.target.value)}
            />
            <span className="text-[10px] mt-1 block" style={{ color: 'var(--text-muted)' }}>
              {weatherHasKey ? '✓ 已保存到 Windows 凭据管理器' : '未配置（保存到 Windows 凭据管理器）'}
            </span>
          </div>
          <button
            className="w-full py-1.5 text-xs font-medium rounded-md transition-all"
            style={{
              backgroundColor: weatherApiKey.trim() ? 'var(--accent)' : 'var(--border-subtle)',
              color: weatherApiKey.trim() ? '#fff' : 'var(--text-muted)',
              cursor: weatherApiKey.trim() && !savingWeatherKey ? 'pointer' : 'not-allowed',
            }}
            disabled={!weatherApiKey.trim() || savingWeatherKey}
            onClick={async () => {
              setSavingWeatherKey(true)
              try {
                await secretSet(SECRET_NAME_QWEATHER, weatherApiKey.trim())
                // 输入框立刻清空，明文不留在界面上
                setWeatherApiKey('')
                setWeatherHasKey(true)
                window.toastAPI?.show?.({ message: '天气 API Key 已保存' })
                notifyWeatherKeyChanged()
              } catch (err) {
                console.error('[设置] 保存天气 API Key 失败:', err)
                window.toastAPI?.show?.({
                  message: `保存失败：${err instanceof Error ? err.message : String(err)}`,
                  color: '#ef4444',
                })
              } finally {
                setSavingWeatherKey(false)
              }
            }}
          >
            保存天气 API Key
          </button>
        </div>
      </section>

      {/* 小牛翻译 API 配置 */}
      <section>
        <SectionTitle>小牛翻译 API</SectionTitle>
        <div className="mt-2 flex flex-col gap-2">
          <div>
            <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>
              App ID
            </label>
            <input
              type="text"
              className="input text-xs"
              value={niutransAppId}
              placeholder="小牛翻译 App ID"
              onChange={(e) => setNiutransAppId(e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>
              API Key
            </label>
            <input
              type="password"
              className="input text-xs"
              value={niutransApiKey}
              placeholder={niutransHasKey ? '已保存（输入新密钥可替换）' : '小牛翻译 API Key'}
              onChange={(e) => setNiutransApiKey(e.target.value)}
            />
          </div>
          <button
            className="w-full py-1.5 text-xs font-medium rounded-md transition-all"
            style={{
              backgroundColor: canSaveNiu ? 'var(--accent)' : 'var(--border-subtle)',
              color: canSaveNiu ? '#fff' : 'var(--text-muted)',
              cursor: canSaveNiu ? 'pointer' : 'not-allowed',
            }}
            disabled={!canSaveNiu}
            onClick={async () => {
              try {
                if (niutransApiKey) {
                  await niutrans.setApiKey(niutransApiKey)
                }
                await niutrans.setAppId(niutransAppId)
                window.toastAPI?.show?.({ message: '小牛翻译 API 已保存' })
                setNiutransHasKey(true)
                setNiutransApiKey('')
              } catch {
                window.toastAPI?.show?.({ message: '保存失败，请重试', color: '#ef4444' })
              }
            }}
          >
            保存翻译 API
          </button>
          <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
            免费注册：
            <a
              href="https://niutrans.com/cloud/api/list"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: 'var(--accent)' }}
            >
              niutrans.com
            </a>
          </span>
        </div>
      </section>

      {/* 系统 */}
      <section>
        <SectionTitle>系统</SectionTitle>
        <div className="mt-2 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="text-sm" style={{ color: 'var(--text-primary)' }}>
              开机自启动
            </span>
            <ToggleSwitch checked={autoStart} onChange={handleAutoStartToggle} />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm" style={{ color: 'var(--text-primary)' }}>
              全局快捷键
            </span>
            <kbd
              style={{
                fontSize: '11px',
                padding: '2px 8px',
                borderRadius: '4px',
                backgroundColor: 'var(--bg-surface)',
                border: '1px solid var(--border-subtle)',
                color: 'var(--text-secondary)',
                fontFamily: 'monospace',
              }}
            >
              Ctrl+Shift+I
            </kbd>
          </div>
        </div>
      </section>

      {/* 插件管理 */}
      <section>
        <SectionTitle>插件管理</SectionTitle>
        <div className="mt-2 flex flex-col gap-2">
          {allPlugins.map((plugin) => {
            const isDisabled = settings.disabledPlugins.includes(plugin.manifest.id)
            const isLocked = plugin.manifest.id === 'settings'

            return (
              <div key={plugin.manifest.id} className="flex items-center justify-between">
                <span
                  className="text-sm"
                  style={{
                    color: isLocked ? 'var(--text-muted)' : 'var(--text-primary)',
                  }}
                >
                  {plugin.manifest.name}
                  {isLocked && (
                    <span className="text-[10px] ml-1.5" style={{ color: 'var(--text-muted)' }}>
                      （锁定）
                    </span>
                  )}
                </span>
                <ToggleSwitch
                  checked={!isDisabled}
                  disabled={isLocked}
                  onChange={() => togglePlugin(plugin.manifest.id)}
                />
              </div>
            )
          })}

          {/* 热重载入口：改完插件源码不用重启应用 */}
          <button
            className="w-full py-1.5 mt-1 text-xs font-medium rounded-md transition-all"
            style={{
              backgroundColor: reloadingPlugins ? 'var(--border-subtle)' : 'var(--bg-surface)',
              color: reloadingPlugins ? 'var(--text-muted)' : 'var(--text-primary)',
              border: '1px solid var(--border-subtle)',
              cursor: reloadingPlugins ? 'wait' : 'pointer',
            }}
            disabled={reloadingPlugins}
            onClick={async () => {
              setReloadingPlugins(true)
              try {
                await reloadPluginSystem()
                setPluginCount(pluginRegistry.getAllPlugins().length)
                window.toastAPI?.show?.({ message: '插件已重新加载' })
              } catch (err) {
                console.error('[设置] 重新加载插件失败:', err)
                window.toastAPI?.show?.({ message: '重新加载插件失败，详见日志台', color: '#ef4444' })
              } finally {
                setReloadingPlugins(false)
              }
            }}
          >
            {reloadingPlugins ? '正在重新加载…' : `重新加载插件（当前 ${pluginCount} 个）`}
          </button>

          {/* 外部插件的导入 / 卸载：不用去 %APPDATA% 找目录 */}
          <div
            className="mt-3 pt-3"
            style={{ borderTop: '1px solid var(--border-subtle)' }}
          >
            <div className="text-[11px] font-semibold mb-1.5" style={{ color: 'var(--text-muted)' }}>
              外部插件
            </div>
            <PluginManager onChanged={() => setPluginCount(pluginRegistry.getAllPlugins().length)} />
          </div>
        </div>
      </section>
    </div>
  )
}

/** 分组标题 */
function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="text-[11px] font-semibold tracking-widest uppercase"
      style={{ color: 'var(--text-muted)' }}
    >
      {children}
    </div>
  )
}

/** Toggle 开关 */
function ToggleSwitch({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean
  disabled?: boolean
  onChange: () => void
}) {
  return (
    <button
      className="relative w-9 h-5 rounded-full transition-colors"
      style={{
        backgroundColor: disabled
          ? 'var(--border-subtle)'
          : checked
            ? 'var(--accent)'
            : 'var(--border-subtle)',
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
      onClick={disabled ? undefined : onChange}
      disabled={disabled}
    >
      <span
        className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform"
        style={{
          transform: checked ? 'translateX(16px)' : 'translateX(0)',
        }}
      />
    </button>
  )
}
