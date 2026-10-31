import type { InfoBoardPlugin } from '@/core/types'
import type { CSSProperties } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

/**
 * API 测活 —— 这个插件自己**不测活**，它是独立工具「API 中转站测活工具」的入口。
 *
 * 为什么不把功能搬进插件：那个工具的核心就是**发网络请求**和**写 Claude Code /
 * Codex / Grok 的配置文件**，而 InfoBoard 的插件跑在 WebView 里，受应用 CSP 限制
 * （connect-src 只列了天气/B站等域名）既不能直接发请求也没有写文件能力；
 * 何况插件只在面板打开时活着。所以它保持独立进程，插件只负责把它拉起来。
 *
 * 与网盘下载器的区别：这个工具**不随应用打包**（它有自己的仓库、自己在迭代），
 * 所以第一次用需要手动指定一次 `api_probe.py` 的位置，之后会记住。
 *
 * 1.1.0 只改插件这一侧：文案追上工具本体（每站多 Key、Grok Build、出口并行竞速），
 * 面板按「缺脚本 / 缺解释器」分别给下一步，并补了「重新检测」。
 * 宿主命令一个没动 —— 仍是 `apiprobe_app_*`，`ToolSection` 里那条按 id 的连接也照旧。
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

const hintStyle: CSSProperties = {
  marginTop: 6,
  fontSize: 11,
  lineHeight: 1.7,
  whiteSpace: 'pre-wrap',
  color: 'var(--text-muted)',
}

/** 状态里的解释器是整条路径，面板上只看文件名就够了（入口那行已经给了全路径） */
function baseName(path?: string | null): string {
  if (!path) return ''
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}

function ApiProbePanel() {
  const [status, setStatus] = useState<AppStatus | null>(null)
  /** 应用版本太老、没有 apiprobe_app_status：这时连选文件都做不了，别给误导性的步骤 */
  const [unsupported, setUnsupported] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<AppStatus | null> => {
    try {
      const next = await invoke<AppStatus>('apiprobe_app_status')
      setStatus(next)
      setUnsupported(false)
      return next
    } catch (e) {
      setStatus({
        available: false,
        message: `当前应用还没有 apiprobe_app_status 命令（需要重新构建应用）：${
          e instanceof Error ? e.message : String(e)
        }`,
      })
      setUnsupported(true)
      return null
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /**
   * 窗口重新获得焦点时复查一次。
   *
   * 典型场景：面板提示"没找到 Python" → 用户去装 Python → 切回来还是那句红字，
   * 只能关掉面板再打开。这里让状态自己跟上，同时保留下面那个手动「重新检测」。
   */
  useEffect(() => {
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
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
      setUnsupported(false)
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
      setUnsupported(false)
      setNotice('已改回自动查找')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [])

  const recheck = useCallback(async () => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const next = await refresh()
      if (next === null) return // 应用版本太老，错误已经写在状态里
      setNotice(next.available ? '已重新检测：已就绪' : '已重新检测：还没找到，按下面的提示处理')
    } finally {
      setBusy(false)
    }
  }, [refresh])

  const ready = status?.available ?? false
  const isCustom = status?.source === 'custom'
  // 没就绪时按缺什么分开说：缺入口要"选文件"，缺解释器要"装 Python 再复查"
  const missingScript = !ready && !unsupported && !!status && !status.script
  const missingPython = !ready && !unsupported && !!status && !!status.script && !status.python

  return (
    <div style={panelStyle}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>📈 API 中转站测活</div>
      <div style={{ color: 'var(--text-muted)', lineHeight: 1.8, marginBottom: 12 }}>
        多站点 / 每站多 Key · 模型与协议探测 · 真实生成测试（首字延迟、疑似掺水线索） ·
        批量巡检
        <br />
        一键接入 Claude Code、Codex（CLI + 桌面版）、Grok Build
        <br />
        独立窗口运行 —— 它要发网络请求、还要写三个 CLI 的配置；写入前自动备份，且是原子写
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
        <button style={buttonStyle(false, !busy)} disabled={busy} onClick={() => void recheck()}>
          重新检测
        </button>
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
              已就绪（{baseName(status.python) || 'python'}）
              <br />
              入口：{status.script}
              {isCustom ? '（手动指定）' : '（自动找到）'}
            </>
          ) : (
            `⚠️ ${status.message}`
          )}
        </div>
      )}

      {missingScript && (
        <div style={hintStyle}>
          ① 点「选择 api_probe.py…」指到工具脚本（文件名必须是 api_probe.py）
          <br />
          ② 选完就能直接开；想让它自动找到，也可以把脚本放到应用目录下的 api-probe\ 里
        </div>
      )}

      {missingPython && (
        <div style={hintStyle}>
          装 Python 3.9+（Windows 官方安装包自带 tkinter），装完点上面的「重新检测」。
          <br />
          已经装了还是找不到？重启 InfoBoard 让 PATH 刷新，或用 INFOBOARD_PYTHON 指定解释器路径。
        </div>
      )}

      <div
        style={{
          marginTop: 10,
          paddingTop: 8,
          borderTop: '1px solid var(--border-subtle)',
          fontSize: 11,
          lineHeight: 1.7,
          color: 'var(--text-muted)',
        }}
      >
        插件只负责把它拉起来：不读你的 Key，也不碰 ~/.claude、~/.codex、~/.grok。
        <br />
        工具默认「系统代理 ∥ 直连」并行竞速，先回来的算数 —— 所以第一次探测偶尔会等上十几秒。
      </div>

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
    version: '1.10.0',
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
