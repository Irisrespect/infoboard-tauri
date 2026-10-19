import type { InfoBoardPlugin } from '@/core/types'
import type { CSSProperties } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

/**
 * API 测活 —— 这个插件自己**不测活**，它是独立工具「API 中转站测活工具」的入口。
 *
 * 为什么不把功能搬进插件：那个工具的核心就是**发网络请求**和**写 Claude Code / Codex
 * 的配置文件**，而 InfoBoard 的插件跑在 WebView 里，受应用 CSP 限制（connect-src 只列了
 * 天气/B站等域名）既不能直接发请求也没有写文件能力；何况插件只在面板打开时活着。
 * 所以它保持独立进程，插件只负责把它拉起来。
 *
 * 与网盘下载器的区别：这个工具**不随应用打包**（它有自己的仓库、自己在迭代），
 * 所以第一次用需要手动指定一次 `api_probe.py` 的位置，之后会记住。
 */

interface AppStatus {
  available: boolean
  script?: string | null
  python?: string | null
  /** bundled = 自动找到的；custom = 用户手动指定的 */
  source?: string | null
  message: string
}

const panelStyle: CSSProperties = { padding: '14px', fontSize: 12, color: 'var(--text-primary)' }

const buttonStyle = (primary: boolean, enabled = true): CSSProperties => ({
  padding: primary ? '9px 18px' : '5px 12px',
  fontSize: primary ? 13 : 12,
  fontWeight: primary ? 600 : 400,
  borderRadius: 6,
  cursor: enabled ? 'pointer' : 'not-allowed',
  border: '1px solid var(--border-subtle)',
  background: primary && enabled ? 'var(--accent)' : 'var(--bg-surface)',
  color: primary && enabled ? '#fff' : 'var(--text-primary)',
  opacity: enabled ? 1 : 0.6,
})

function ApiProbePanel() {
  const [status, setStatus] = useState<AppStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setStatus(await invoke<AppStatus>('apiprobe_app_status'))
    } catch (e) {
      setStatus({
        available: false,
        message: `当前应用还没有 apiprobe_app_status 命令（需要重新构建应用）：${
          e instanceof Error ? e.message : String(e)
        }`,
      })
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const launch = useCallback(async () => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      setNotice(await invoke<string>('apiprobe_app_launch'))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [])

  /** 手动指定入口：只选一次，之后记住 */
  const pick = useCallback(async () => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const picked = await invoke<string | string[] | null>('plugin:dialog|open', {
        options: {
          multiple: false,
          title: '选择 api_probe.py',
          filters: [{ name: 'Python 脚本', extensions: ['py'] }],
        },
      })
      const path = Array.isArray(picked) ? picked[0] : picked
      if (!path) return // 用户取消了
      const next = await invoke<AppStatus>('apiprobe_app_set_path', { path })
      setStatus(next)
      setNotice(next.available ? '已记住这个位置' : next.message)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [])

  const reset = useCallback(async () => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      setStatus(await invoke<AppStatus>('apiprobe_app_clear_path'))
      setNotice('已改回自动查找')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [])

  const ready = status?.available ?? false
  const isCustom = status?.source === 'custom'

  return (
    <div style={panelStyle}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>📈 API 中转站测活</div>
      <div style={{ color: 'var(--text-muted)', lineHeight: 1.8, marginBottom: 12 }}>
        站点与多 Key 管理 · 模型列表探测 · 批量测速与流畅度 · 一键接入 Claude Code / Codex
        <br />
        独立窗口运行 —— 它要发网络请求、还要写 Claude/Codex 的配置，这些在插件沙箱里做不了
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <button
          style={buttonStyle(true, ready && !busy)}
          disabled={busy || !ready}
          onClick={() => void launch()}
        >
          {busy ? '处理中…' : '打开测活工具'}
        </button>
        <button style={buttonStyle(false, !busy)} disabled={busy} onClick={() => void pick()}>
          {ready ? '换个位置…' : '选择 api_probe.py…'}
        </button>
        {isCustom && (
          <button style={buttonStyle(false, !busy)} disabled={busy} onClick={() => void reset()}>
            改回自动查找
          </button>
        )}
      </div>

      {status && (
        <div
          style={{
            marginTop: 10,
            fontSize: 11,
            lineHeight: 1.7,
            whiteSpace: 'pre-wrap',
            color: ready ? 'var(--text-muted)' : '#d9534f',
          }}
        >
          {ready ? (
            <>
              已就绪（{status.python || 'python'}）
              <br />
              入口：{status.script}
              {isCustom ? '（手动指定）' : '（自动找到）'}
            </>
          ) : (
            `⚠️ ${status.message}`
          )}
        </div>
      )}
      {notice && <div style={{ marginTop: 6, fontSize: 11, color: 'var(--accent)' }}>{notice}</div>}
      {error && (
        <div style={{ marginTop: 6, fontSize: 11, color: '#d9534f', whiteSpace: 'pre-wrap' }}>
          {error}
        </div>
      )}
    </div>
  )
}

const ApiProbePlugin: InfoBoardPlugin = {
  manifest: {
    id: 'api-probe',
    name: 'API',
    version: '1.0.1',
    section: 'tool',
    // 与其它工具插件一致的具名线性图标（宿主 SVG_ICONS 注册表里的 Lucide 图标）
    icon: 'activity',
    color: 'var(--accent)',
    description: '打开 API 中转站测活工具',
  },
  Component: ApiProbePanel,
  onInit: () => console.log('[API 测活] 插件已加载'),
  onDestroy: () => console.log('[API 测活] 插件已卸载'),
}

export default ApiProbePlugin
