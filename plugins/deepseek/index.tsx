/**
 * DeepSeek 网页 HUD
 *
 * 点工具区图标**直接**弹出一个常驻小窗，里面就是 chat.deepseek.com —— 等于
 * 一个只装了一个站点的精简浏览器：登录一次，之后关掉应用也不用再登。
 *
 * 为什么不把网站嵌进这个面板：
 * - 站点用 `X-Frame-Options` / `frame-ancestors` 禁止被嵌，iframe 直接白屏
 * - 面板是主窗口的一部分，主窗口只有几百像素宽，聊天区会被挤成一条缝
 *
 * 真正的窗口由宿主创建（命令 `hud_open_deepseek`，见 src-tauri/src/plugins/hud）。
 * 外部插件建不了窗口，所以这里只负责"按一下"。
 *
 * 下面这个组件是**兜底**：只有当宿主没有"点图标直接开窗"的特殊处理时才会渲染，
 * 至少还能手动点一下打开（和网盘/B 站下载器的做法一致）。
 */

import type { InfoBoardPlugin, PluginComponentProps } from '@/core/types'
import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  if (e && typeof e === 'object') {
    const o = e as Record<string, unknown>
    if (typeof o.message === 'string') return o.message
  }
  return String(e ?? '未知错误')
}

function DeepSeekPanel(_props: PluginComponentProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [opened, setOpened] = useState(false)

  const open = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      // 位置在这里算：宿主不去查主窗口几何（那要跨线程往返，会把 UI 卡住）
      await invoke('hud_open_deepseek', {
        anchor: {
          x: window.screenX,
          y: window.screenY,
          width: window.outerWidth,
          height: window.outerHeight,
        },
      })
      setOpened(true)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }, [])

  // 面板一出现就自动开一次：多数情况下用户点图标就是想聊天，不该再点第二下。
  // 注意**不要**放到 onInit —— 那会在应用启动时给所有插件跑一遍，一开机就弹窗。
  useEffect(() => {
    void open()
  }, [open])

  return (
    <div style={{ padding: '12px 14px', fontSize: 12, color: 'var(--text-primary)' }}>
      {/* 图标不在面板里重复画：工具区用的是宿主 SVG_ICONS 里注册的 `whale`，
          这里再写一份 emoji 或另一套路径只会两边不一致 */}
      <div style={{ fontWeight: 600, marginBottom: 6 }}>DeepSeek 对话</div>

      <div style={{ color: 'var(--text-muted)', lineHeight: 1.7, marginBottom: 10 }}>
        独立小窗 · 就是 chat.deepseek.com 本身
        <br />
        登录一次就记住，关掉应用也不用重登
      </div>

      <button
        type="button"
        onClick={() => void open()}
        disabled={busy}
        style={{
          padding: '8px 16px',
          fontSize: 12.5,
          fontWeight: 600,
          borderRadius: 7,
          cursor: busy ? 'wait' : 'pointer',
          border: '1px solid var(--border-subtle)',
          background: 'var(--accent)',
          color: '#fff',
          opacity: busy ? 0.6 : 1,
        }}
      >
        {busy ? '正在打开…' : opened ? '唤到前面' : '打开 DeepSeek'}
      </button>

      {error && (
        <div
          style={{
            marginTop: 10,
            fontSize: 11,
            lineHeight: 1.6,
            color: '#dc2626',
            whiteSpace: 'pre-wrap',
          }}
        >
          {error}
        </div>
      )}
    </div>
  )
}

const DeepSeekPlugin: InfoBoardPlugin = {
  manifest: {
    id: 'deepseek',
    name: 'DeepSeek',
    version: '1.2.0',
    author: 'InfoBoard',
    description: '点一下弹出 DeepSeek 网页小窗，直接在应用里聊天',
    section: 'tool',
    // 用具名 SVG 图标（宿主 SVG_ICONS 里的 `whale`），和截图/设置/翻译/网盘那一排
    // 线性图标同源。emoji 是彩色字形，粗细和尺寸都不受控，放在一起很扎眼。
    icon: 'whale',
    color: 'var(--accent)',
  },
  Component: DeepSeekPanel,
  onInit: () => console.log('[DeepSeek] 插件已加载'),
  onDestroy: () => console.log('[DeepSeek] 插件已卸载'),
}

export default DeepSeekPlugin
