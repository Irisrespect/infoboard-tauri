/**
 * 插件管理（导入 / 卸载）
 *
 * 两种把插件装进来的方式，都不需要用户去找 `%APPDATA%` 目录：
 * 1. 把 `.ibplugin` 文件**拖进虚线框**
 * 2. 点「选择插件包」走系统文件选择器
 *
 * 卸载分两步（见 `pluginPack.ts`）：先把插件目录挪走，重新加载插件系统触发
 * 组件卸载，再真正删文件 —— Windows 上被加载中的模块占用会直接删不掉。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { pluginRegistry } from '../../core/PluginRegistry'
import { reloadPluginSystem } from '../../core/PluginHost'
import { errorMessage } from '../../core/errorMessage'
import {
  PLUGIN_PACKAGE_EXT,
  installPluginPackage,
  listInstalledPlugins,
  looksLikePluginPackage,
  purgeUninstalledPlugin,
  uninstallPlugin,
  type InstalledPlugin,
} from './pluginPack'

interface PluginManagerProps {
  /** 插件系统重新加载完成后通知外层刷新计数 */
  onChanged?: () => void
}

export function PluginManager({ onChanged }: PluginManagerProps) {
  const [installed, setInstalled] = useState<InstalledPlugin[]>([])
  const [installing, setInstalling] = useState(false)
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)
  const messageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 拖拽监听只注册一次，回调里通过这两个 ref 取最新实现（见下面 effect 的注释）
  const installRef = useRef<(path: string) => Promise<void>>(async () => {})
  const messageRef = useRef<(text: string, ok: boolean) => void>(() => {})

  const showMessage = useCallback((text: string, ok: boolean) => {
    setMessage({ text, ok })
    if (messageTimerRef.current) clearTimeout(messageTimerRef.current)
    messageTimerRef.current = setTimeout(() => setMessage(null), 6000)
  }, [])

  const refreshList = useCallback(async () => {
    try {
      setInstalled(await listInstalledPlugins())
    } catch (err) {
      console.warn('[插件管理] 读取插件列表失败:', err)
    }
  }, [])

  useEffect(() => {
    void refreshList()
    return () => {
      if (messageTimerRef.current) clearTimeout(messageTimerRef.current)
    }
  }, [refreshList])

  /** 装完/卸完统一走这里：重新扫描并让界面刷新 */
  const reloadAfterChange = useCallback(async () => {
    await reloadPluginSystem()
    await refreshList()
    onChanged?.()
  }, [refreshList, onChanged])

  const doInstall = useCallback(
    async (path: string) => {
      if (installing) return
      if (!looksLikePluginPackage(path)) {
        showMessage(`请拖入 .${PLUGIN_PACKAGE_EXT} 插件包（当前文件不是）`, false)
        return
      }
      setInstalling(true)
      try {
        const id = await installPluginPackage(path)
        await reloadAfterChange()
        showMessage(`已安装插件：${id}`, true)
      } catch (err) {
        // 失败原因来自 Rust（包损坏 / 缺 manifest / id 非法 / 过大等），直接展示给用户
        showMessage(`安装失败：${errorMessage(err)}`, false)
      } finally {
        setInstalling(false)
      }
    },
    [installing, reloadAfterChange, showMessage]
  )

  const doPickFile = useCallback(async () => {
    try {
      const picked = await openDialog({
        multiple: false,
        directory: false,
        title: '选择插件包',
        filters: [{ name: 'InfoBoard 插件包', extensions: [PLUGIN_PACKAGE_EXT, 'zip'] }],
      })
      const path = typeof picked === 'string' ? picked : null
      if (path) await doInstall(path)
    } catch (err) {
      showMessage(`打开文件选择器失败：${errorMessage(err)}`, false)
    }
  }, [doInstall, showMessage])

  const doUninstall = useCallback(
    async (plugin: InstalledPlugin) => {
      if (removingId) return
      setRemovingId(plugin.id)
      try {
        // 第一步：先把目录挪走，插件立刻不再被扫描到
        await uninstallPlugin(plugin.id)
        // 第二步：重新加载 —— 这一步会触发 onDestroy 并卸载组件
        await reloadAfterChange()
        // 第三步：组件已卸载，文件不再被占用，真正删除
        await purgeUninstalledPlugin(plugin.id)
        await refreshList()
        showMessage(`已卸载插件：${plugin.name || plugin.id}`, true)
      } catch (err) {
        showMessage(`卸载失败：${errorMessage(err)}`, false)
        // 即使失败也刷新一下：目录可能已被挪走
        void refreshList()
      } finally {
        setRemovingId(null)
      }
    },
    [removingId, reloadAfterChange, refreshList, showMessage]
  )

  // 每次渲染刷新 ref，保证拖拽回调总能拿到最新的实现
  installRef.current = doInstall
  messageRef.current = showMessage

  // 拖拽：用 Tauri 的文件拖放事件（WebView 里 HTML5 的 drop 拿不到真实路径）
  //
  // 注意依赖必须是**稳定**的：doInstall 依赖 installing，安装期间身份会变，
  // 若把它写进依赖数组，监听器会在安装过程中被拆掉重建 —— 正好丢掉后续事件。
  // 所以这里通过 ref 读最新实现，effect 只在挂载时注册一次。
  useEffect(() => {
    let unlisten: (() => void) | undefined
    let cancelled = false

    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload
        if (payload.type === 'enter') {
          // 只有拖的是插件包才高亮，避免误导
          setDragActive(payload.paths.some(looksLikePluginPackage))
        } else if (payload.type === 'drop') {
          setDragActive(false)
          const pkg = payload.paths.find(looksLikePluginPackage)
          if (pkg) {
            void installRef.current(pkg)
          } else if (payload.paths.length > 0) {
            messageRef.current(`请拖入 .${PLUGIN_PACKAGE_EXT} 插件包`, false)
          }
        } else if (payload.type === 'leave') {
          setDragActive(false)
        }
        // over：光标移动，不用管
      })
      .then((fn) => {
        if (cancelled) fn()
        else unlisten = fn
      })
      .catch((err) => {
        console.warn('[插件管理] 注册拖拽监听失败:', err)
      })

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  const busy = installing || removingId !== null

  return (
    <div className="flex flex-col gap-2">
      {/* 拖拽导入区 */}
      <div
        className="rounded-lg p-3 text-center transition-colors"
        style={{
          border: `1.5px dashed ${
            dragActive ? 'var(--accent)' : 'var(--border-subtle)'
          }`,
          backgroundColor: dragActive
            ? 'color-mix(in srgb, var(--accent) 8%, transparent)'
            : 'transparent',
          cursor: busy ? 'wait' : 'pointer',
        }}
        onClick={() => {
          if (!busy) void doPickFile()
        }}
      >
        <div className="text-xs" style={{ color: 'var(--text-primary)' }}>
          {installing
            ? '正在安装…'
            : dragActive
              ? `松开即可安装 .${PLUGIN_PACKAGE_EXT}`
              : `把 .${PLUGIN_PACKAGE_EXT} 插件包拖到这里`}
        </div>
        <div className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
          或点这里选择文件 · 同 id 的包会覆盖安装（等于升级）
        </div>
      </div>

      {/* 结果提示 */}
      {message && (
        <div
          className="text-[11px] px-2 py-1.5 rounded"
          style={{
            color: message.ok ? 'var(--text-primary)' : '#ef4444',
            backgroundColor: message.ok
              ? 'var(--bg-surface)'
              : 'color-mix(in srgb, #ef4444 12%, transparent)',
            wordBreak: 'break-word',
          }}
        >
          {message.ok ? '✅ ' : '⚠️ '}
          {message.text}
        </div>
      )}

      {/* 已安装列表 */}
      <div className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>
        已安装的外部插件（{installed.length}）
      </div>

      {installed.length === 0 ? (
        <div className="text-[11px] py-1" style={{ color: 'var(--text-muted)' }}>
          暂无外部插件。内置插件不在此列表（它们随应用发布，不可卸载）。
        </div>
      ) : (
        <ul className="flex flex-col gap-1">
          {installed.map((p) => (
            <li
              key={`${p.id}@${p.dirName}`}
              className="flex items-center gap-2 px-2 py-1.5 rounded-md"
              style={{ backgroundColor: 'var(--bg-main)' }}
            >
              <span className="text-sm shrink-0" aria-hidden="true">
                {p.icon || '🔌'}
              </span>
              <span className="flex flex-col min-w-0 flex-1">
                <span
                  className="text-xs truncate"
                  style={{ color: 'var(--text-primary)' }}
                  title={`${p.name}（${p.id}）`}
                >
                  {p.name || p.id}
                  <span className="ml-1" style={{ color: 'var(--text-muted)' }}>
                    v{p.version}
                  </span>
                </span>
                <span className="text-[10px] truncate" style={{ color: 'var(--text-muted)' }}>
                  {p.id}
                  {p.manual ? ' · 手动放置' : ''}
                  {p.author ? ` · ${p.author}` : ''}
                </span>
              </span>
              <button
                className="shrink-0 px-2 py-0.5 text-[11px] rounded transition-colors"
                style={{
                  color: removingId === p.id ? 'var(--text-muted)' : '#ef4444',
                  border: '1px solid var(--border-subtle)',
                  cursor: removingId === p.id ? 'wait' : 'pointer',
                }}
                disabled={busy}
                onClick={(e) => {
                  e.stopPropagation()
                  void doUninstall(p)
                }}
                aria-label={`卸载插件 ${p.name || p.id}`}
                title={
                  p.manual
                    ? '卸载会删除该插件目录（手动放置的也会一起删掉）'
                    : '卸载并删除插件文件'
                }
              >
                {removingId === p.id ? '卸载中…' : '卸载'}
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* 插件总数（含内置），便于确认重新加载是否生效 */}
      <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
        当前注册表中共 {pluginRegistry.getAllPlugins().length} 个插件（含内置）
      </div>
    </div>
  )
}
