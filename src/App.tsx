import { useState, useCallback, useEffect } from 'react'
import { TitleBar } from './components/TitleBar'
import { InfoSection } from './components/InfoSection'
import { ToolSection } from './components/ToolSection'
import { clampMenuPosition, isMenuCloseKey } from './components/contextMenu'

export default function App() {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)

  // 右键菜单（位置钳制在可视区内，否则右下角右键会点不到菜单项）
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setMenu(
      clampMenuPosition(
        { x: e.clientX, y: e.clientY },
        { width: window.innerWidth, height: window.innerHeight }
      )
    )
  }, [])

  // 点击任意位置 / 按 Esc 关闭菜单
  useEffect(() => {
    const close = () => setMenu(null)
    const onKeyDown = (e: KeyboardEvent) => {
      if (isMenuCloseKey(e.key)) setMenu(null)
    }
    window.addEventListener('click', close)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  // 切换标题栏显隐
  const toggleTitleBar = useCallback(async () => {
    if (window.electronAPI) {
      await window.electronAPI.toggleTitleBar()
    }
    setMenu(null)
  }, [])

  // 关闭窗口
  const closeWindow = useCallback(async () => {
    if (window.electronAPI) {
      await window.electronAPI.close()
    }
  }, [])

  return (
    <div className="min-h-screen bg-bg-main flex flex-col" onContextMenu={handleContextMenu}>
      {/* 自定义标题栏 */}
      <TitleBar />

      {/* 内容区 */}
      <main className="flex-1 flex flex-col p-5 gap-6 overflow-auto">
        <InfoSection />
        <ToolSection />
      </main>

      {/* 右键菜单 */}
      {menu && (
        <div
          className="fixed z-50 py-1 rounded-lg shadow-lg border"
          style={{
            left: menu.x,
            top: menu.y,
            backgroundColor: 'var(--bg-surface)',
            borderColor: 'var(--border-subtle)',
            minWidth: 140,
          }}
        >
          <button
            className="w-full text-left px-3 py-1.5 text-xs transition-colors"
            style={{ color: 'var(--text-primary)' }}
            onMouseEnter={(e) =>
              (e.currentTarget.style.backgroundColor = 'var(--bg-surface-hover)')
            }
            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
            onClick={toggleTitleBar}
          >
            显示/隐藏标题栏
          </button>
          <button
            className="w-full text-left px-3 py-1.5 text-xs transition-colors"
            style={{ color: 'var(--text-primary)' }}
            onMouseEnter={(e) =>
              (e.currentTarget.style.backgroundColor = 'var(--bg-surface-hover)')
            }
            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
            onClick={() => {
              window.dispatchEvent(new CustomEvent('log-console-toggle'))
              setMenu(null)
            }}
          >
            打开日志台 (F12)
          </button>
          <div className="mx-2 my-1" style={{ borderTop: '1px solid var(--border-subtle)' }} />
          <button
            className="w-full text-left px-3 py-1.5 text-xs transition-colors"
            style={{ color: '#ef4444' }}
            onMouseEnter={(e) =>
              (e.currentTarget.style.backgroundColor = 'var(--bg-surface-hover)')
            }
            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
            onClick={closeWindow}
          >
            关闭窗口
          </button>
        </div>
      )}
    </div>
  )
}
