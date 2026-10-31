import type { CSSProperties } from 'react'
import type { InfoBoardPlugin } from '@/core/types'
import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

/**
 * 网盘下载 —— 这个插件自己**不下载**，它是独立软件「网盘下载器」的入口。
 *
 * 这里的「网盘下载」是两家的合并版：**夸克**和**迅雷**共用一个输入框、一套下载队列。
 * 合并之前是两个插件（夸克网盘 / 迅雷云盘），各自拉起各自的窗口；合并之后只剩这一个，
 * 因为用户要的从来不是"再开一个窗口"，而是"粘个链接就能下完"。
 *
 * 点工具区的图标时，宿主会直接把这个独立软件拉起来（见 `ToolSection` 里对
 * `netdisk` 的特殊处理，和截图插件同一套做法），**不展开中间面板**。
 *
 * 为什么下载必须放到独立软件里做：插件跑在 WebView 中，只在面板打开时运行，
 * 而网盘直链只有 5~10 分钟有效期 —— 面板一关就没人换链，大文件必然下不完。
 * 独立进程自己就能一直下、自己换链，也不受应用 CSP（插件既不能直接发请求、
 * 也不能写文件）限制。
 *
 * 拉起用的是宿主的**通用伴随程序命令** `companion_launch(id)`：id 只是注册表里的
 * 白名单键（netdisk / apiprobe / bilidl），查不到就报错 —— 所以这组命令不会
 * 变成"任何插件都能启动任意程序"的口子。
 *
 * 下面这个组件是**兜底**：只有当宿主没有"点图标直接启动"这条特殊处理时才会渲染，
 * 它至少还能让用户手动点一下把软件打开，或者在自动查找失败时手动指定一次位置。
 */

const COMPANION_ID = 'netdisk'

interface AppStatus {
  available: boolean
  script?: string | null
  python?: string | null
  /** plugin = 插件包自带的；bundled = 随安装包找到的；custom = 用户手动指定的 */
  source?: string | null
  /** 实际要跑的那份程序的版本（程序目录里的 VERSION） */
  version?: string | null
  /** 插件 manifest 声明的版本（companion.version） */
  expected?: string | null
  message: string
}

const panelStyle: CSSProperties = { padding: '14px', fontSize: 12, color: 'var(--text-primary)' }

/**
 * 入口来自哪里。
 * `plugin` = 插件包自带（`.ibplugin` 里那份，可热更新）；
 * `bundled` = 随安装包资源；`custom` = 用户手动指定。
 */
function sourceLabel(source?: string | null): string {
  switch (source) {
    case 'plugin':
      return '（插件包自带）'
    case 'custom':
      return '（手动指定）'
    default:
      return '（随安装包）'
  }
}

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

function NetdiskPanel() {
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

  /** 手动指定入口：只选一次，之后记住（装到别处 / 便携版都靠它） */
  const pick = useCallback(async () => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const picked = await invoke<string | string[] | null>('plugin:dialog|open', {
        options: {
          multiple: false,
          title: '选择 netdisk-app/main.py',
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
        <div style={{ fontWeight: 600, marginBottom: 6 }}>☁️ 网盘下载器</div>
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
      <div style={{ fontWeight: 600, marginBottom: 6 }}>☁️ 网盘下载器</div>
      <div style={{ color: 'var(--text-muted)', lineHeight: 1.8, marginBottom: 12 }}>
        夸克 / 迅雷分享链接 · 目录浏览 · 多连接高速下载
        <br />
        独立进程运行 —— 关掉本面板也会继续下载、直链过期自动换链
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <button
          style={buttonStyle(true, ready && !busy)}
          disabled={busy || !ready}
          onClick={() => void launch()}
        >
          {busy ? '处理中…' : '打开网盘下载器'}
        </button>
        <button style={buttonStyle(false, !busy)} disabled={busy} onClick={() => void pick()}>
          {ready ? '换个位置…' : '选择 main.py…'}
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
              {sourceLabel(status.source)}
              <br />
              程序版本：{status.version || '未知'}
              {status.expected && status.version && status.expected !== status.version
                ? `（⚠️ 插件声明 ${status.expected}，重装插件包或应用任一方即可对齐）`
                : ''}
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

const NetdiskPlugin: InfoBoardPlugin = {
  manifest: {
    id: 'netdisk',
    name: '网盘下载',
    version: '2.1.0',
    section: 'tool',
    // 用具名 SVG 图标（宿主 SVG_ICONS 注册表里的 Lucide 图标），跟截图/设置/翻译一致。
    // 用 emoji 会在工具区里显得格格不入：它是彩色字形，跟线性图标的风格不统一。
    icon: 'cloud-download',
    color: 'var(--accent)',
    description: '打开网盘下载器（夸克 / 迅雷分享解析 + 多连接高速下载）',
  },
  Component: NetdiskPanel,
  onInit: () => console.log('[网盘下载] 插件已加载'),
  onDestroy: () => console.log('[网盘下载] 插件已卸载'),
}

export default NetdiskPlugin
