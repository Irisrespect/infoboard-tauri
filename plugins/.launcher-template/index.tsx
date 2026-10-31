import type { CSSProperties } from 'react'
import type { InfoBoardPlugin } from '@/core/types'
import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

/**
 * 启动器插件模板：**插件自带一个程序**，宿主只负责把它拉起来。
 *
 * 为什么要有这条路线：插件跑在 WebView 里 —— 不能联网到任意域名（CSP）、
 * 不能写文件、不能起进程，而且面板一关就停了。需要这些能力的功能，
 * 就得做成独立程序，插件只当入口。
 *
 * 关键点（宿主 0.9+ 才支持 `companion`，0.8 及更早只认 3 个内置 id）：
 * - 程序打进 `.ibplugin`（`app/` 目录），路径由宿主拼，插件**不传路径**；
 * - 插件只调 `companion_status` / `companion_launch`，id 就是自己的插件 id；
 * - 宿主不需要认识这个插件 —— 导入包即可用。
 */

const PLUGIN_ID = 'my-tool'

interface AppStatus {
  available: boolean
  script?: string | null
  /** plugin = 插件包自带；bundled = 随安装包；custom = 用户手动指定 */
  source?: string | null
  version?: string | null
  expected?: string | null
  message: string
}

const panelStyle: CSSProperties = { padding: 14, fontSize: 12, color: 'var(--text-primary)' }

function ToolPanel() {
  const [status, setStatus] = useState<AppStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setStatus(await invoke<AppStatus>('companion_status', { id: PLUGIN_ID }))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const launch = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      await invoke<string>('companion_launch', { id: PLUGIN_ID })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [])

  const conflict =
    status?.version && status.expected && status.version !== status.expected
      ? `⚠️ 版本不一致：插件声明 ${status.expected}，实际 ${status.version}`
      : null

  return (
    <div style={panelStyle}>
      <div style={{ fontWeight: 600, marginBottom: 8 }}>🔧 我的工具</div>
      <button
        onClick={() => void launch()}
        disabled={busy || !status?.available}
        style={{ padding: '8px 16px', borderRadius: 6, cursor: busy ? 'wait' : 'pointer' }}
      >
        {busy ? '启动中…' : '打开'}
      </button>
      {status && (
        <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.7 }}>
          程序：{status.script || '（还没找到）'}
          <br />
          版本：{status.version || '未知'}
          {conflict && (
            <>
              <br />
              <span style={{ color: '#d9534f' }}>{conflict}</span>
            </>
          )}
        </div>
      )}
      {error && (
        <div style={{ marginTop: 8, fontSize: 11, color: '#d9534f', whiteSpace: 'pre-wrap' }}>
          {error}
        </div>
      )}
    </div>
  )
}

const MyToolPlugin: InfoBoardPlugin = {
  manifest: {
    id: PLUGIN_ID,
    name: '我的工具',
    version: '1.0.0',
    section: 'tool',
    icon: '🔧',
    color: 'var(--accent)',
    description: '插件自带程序的启动器模板',
  },
  Component: ToolPanel,
}

export default MyToolPlugin
