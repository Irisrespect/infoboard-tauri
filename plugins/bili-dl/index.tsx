import type { InfoBoardPlugin } from '@/core/types'
import type { CSSProperties } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

/**
 * B站下载 —— 这个插件自己**不下载**，它是独立程序「B 站下载器」的入口。
 *
 * 和「网盘下载」「API 测活」是同一套做法：插件跑在主窗口 WebView 里，按
 * docs/PLUGIN_API.md 的边界既不能发网络请求（CSP 只放通 api.bilibili.com，
 * 且 B 站接口对异源 Origin 直接 403）、也不能写文件、更不能起进程；
 * 而下载需要 yt-dlp 一直跑到结束。所以下载能力放在 `bili-dl-app/bili_dl.py`
 * 这个 tkinter 程序里，插件只负责把它拉起来。
 *
 * 拉起用的是宿主新给的**通用命令** `companion_launch(id)`：
 * id 只是注册表里的白名单键（netdisk / apiprobe / bilidl），
 * 查不到就报错，所以它不会变成"任何插件都能启动任意程序"的口子。
 */

interface AppStatus {
  available: boolean
  script?: string | null
  python?: string | null
  /** bundled = 随包找到的；custom = 用户手动指定的 */
  source?: string | null
  message: string
}

const COMPANION_ID = 'bilidl'

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

function BiliDownloaderPanel() {
  const [status, setStatus] = useState<AppStatus | null>(null)
  const [unsupported, setUnsupported] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setStatus(await invoke<AppStatus>('companion_status', { id: COMPANION_ID }))
      setUnsupported(false)
    } catch (e) {
      // 旧版本应用里还没有通用启动器命令 → 明确告诉用户要重新编译，而不是转圈
      setUnsupported(true)
      setError(e instanceof Error ? e.message : String(e))
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
      setNotice(await invoke<string>('companion_launch', { id: COMPANION_ID }))
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
          title: '选择 bili_dl.py',
          filters: [{ name: 'Python 脚本', extensions: ['py'] }],
        },
      })
      const path = Array.isArray(picked) ? picked[0] : picked
      if (!path) return // 用户取消了
      const next = await invoke<AppStatus>('companion_set_path', { id: COMPANION_ID, path })
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
      setStatus(await invoke<AppStatus>('companion_clear_path', { id: COMPANION_ID }))
      setNotice('已改回自动查找')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [])

  const ready = status?.available ?? false
  const isCustom = status?.source === 'custom'

  if (unsupported) {
    return (
      <div style={panelStyle}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>📥 B 站下载器</div>
        <div style={{ color: 'var(--text-muted)', lineHeight: 1.8 }}>
          当前安装的 InfoBoard 里还没有通用启动器命令（<code>companion_status</code>），
          用旧版本是开不起来的。
          <br />
          重新编译一次应用（<code>npm run tauri build</code>）后重装插件即可。
        </div>
      </div>
    )
  }

  return (
    <div style={panelStyle}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>📥 B 站下载器</div>
      <div style={{ color: 'var(--text-muted)', lineHeight: 1.8, marginBottom: 12 }}>
        粘链接 · 多画质/编码 · 浏览器登录态 · 分P · 下载队列
        <br />
        独立窗口运行 —— 要发请求、要写文件、要等 yt-dlp 跑完，这些在插件沙箱里做不了
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <button
          style={buttonStyle(true, ready && !busy)}
          disabled={busy || !ready}
          onClick={() => void launch()}
        >
          {busy ? '处理中…' : '打开下载器'}
        </button>
        <button style={buttonStyle(false, !busy)} disabled={busy} onClick={() => void pick()}>
          {ready ? '换个位置…' : '选择 bili_dl.py…'}
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
              {isCustom ? '（手动指定）' : '（随包找到）'}
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

const BiliDownloaderPlugin: InfoBoardPlugin = {
  manifest: {
    id: 'bili-dl',
    name: 'B站下载',
    version: '1.1.2',
    section: 'tool',
    icon: 'download',
    color: 'var(--accent)',
    description: '打开独立的 B 站下载器（tkinter 界面，yt-dlp 驱动）',
  },
  Component: BiliDownloaderPanel,
  onInit: () => console.log('[B站下载] 插件已加载'),
  onDestroy: () => console.log('[B站下载] 插件已卸载'),
}

export default BiliDownloaderPlugin
