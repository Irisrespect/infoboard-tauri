import type { InfoBoardPlugin } from '@/core/types'
import type { CSSProperties } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

/**
 * 网盘下载 —— 这个插件自己**不下载**，它是独立软件「网盘下载器」的入口。
 *
 * 点工具区的图标时，宿主会直接把这个独立软件拉起来（见 `ToolComponents/ToolSection`
 * 里对 `netdisk` 的特殊处理，和截图插件同一套做法），**不展开中间面板**。
 *
 * 为什么下载要放到独立软件里做：插件跑在 WebView 中，只在面板打开时运行，
 * 而网盘直链只有 5~10 分钟有效期 —— 面板一关就没人换链，大文件必然下不完。
 * 独立进程自己就能一直下、自己换链，也不受应用 CSP（插件既不能直接发请求、
 * 也不能写文件）限制。
 *
 * 下面这个组件是**兜底**：只有当宿主没有"点图标直接启动"这条特殊处理时才会渲染，
 * 它至少还能让用户手动点一下把软件打开。
 */

interface AppStatus {
  available: boolean
  script?: string | null
  python?: string | null
  message: string
}

const panelStyle: CSSProperties = { padding: '14px', fontSize: 12, color: 'var(--text-primary)' }

function LauncherPanel() {
  const [status, setStatus] = useState<AppStatus | null>(null)
  const [launching, setLaunching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    invoke<AppStatus>('netdisk_app_status')
      .then(setStatus)
      .catch(() =>
        setStatus({
          available: false,
          message: '当前应用还没有 netdisk_app_status 命令（需要重新构建应用）',
        })
      )
  }, [])

  const launch = useCallback(async () => {
    setLaunching(true)
    setError(null)
    try {
      setNotice(await invoke<string>('netdisk_app_launch'))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLaunching(false)
    }
  }, [])

  const ready = status?.available ?? false

  return (
    <div style={panelStyle}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>☁️ 网盘下载器</div>
      <div style={{ color: 'var(--text-muted)', lineHeight: 1.7, marginBottom: 10 }}>
        独立窗口 · 支持夸克网盘分享链接 · 多连接高速下载
        <br />
        独立进程，关掉本面板也会继续下载、自动换链
      </div>

      <button
        style={{
          padding: '9px 18px',
          fontSize: 13,
          fontWeight: 600,
          borderRadius: 6,
          cursor: ready ? 'pointer' : 'not-allowed',
          border: '1px solid var(--border-subtle)',
          background: ready ? 'var(--accent)' : 'var(--bg-surface)',
          color: ready ? '#fff' : 'var(--text-muted)',
          opacity: ready ? 1 : 0.6,
        }}
        disabled={launching || !ready}
        onClick={() => void launch()}
      >
        {launching ? '正在启动…' : '打开网盘下载器'}
      </button>

      {status && (
        <div
          style={{
            marginTop: 10,
            fontSize: 11,
            lineHeight: 1.6,
            whiteSpace: 'pre-wrap',
            color: ready ? 'var(--text-muted)' : '#d9534f',
          }}
        >
          {ready ? `已就绪（${status.python || 'python'}）` : `⚠️ ${status.message}`}
        </div>
      )}
      {notice && <div style={{ marginTop: 6, fontSize: 11, color: 'var(--accent)' }}>{notice}</div>}
    </div>
  )
}

const NetdiskPlugin: InfoBoardPlugin = {
  manifest: {
    id: 'netdisk',
    name: '网盘下载',
    version: '1.2.0',
    section: 'tool',
    icon: '☁️',
    description: '打开网盘下载器（夸克网盘多连接高速下载）',
  },
  Component: LauncherPanel,
  onInit: () => console.log('[网盘下载] 插件已加载'),
  onDestroy: () => console.log('[网盘下载] 插件已卸载'),
}

export default NetdiskPlugin
