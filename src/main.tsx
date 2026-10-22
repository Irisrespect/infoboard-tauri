import React, { useState, useEffect } from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import GlobalToast from './core/GlobalToast'
import LogConsole from './core/LogConsole'
import { installLogConsole } from './core/appLog'
import { ErrorBoundary } from './core/ErrorBoundary'
import { initTauriShim } from './tauri-shim'
import { ScreenshotOverlayWindow } from './components/ScreenshotOverlayWindow'
import './styles/globals.css'
import './styles/fonts.css'
import { toggleNativeDevtools } from './core/devtools'
import { migrateLegacySecrets } from './plugins/settings/secrets'

// 尽早拦截 console，确保后续插件日志都能进面板
installLogConsole()
initTauriShim()
// P1-a：把旧版本明文存在 localStorage 里的 API Key 迁到 Windows 凭据管理器，
// 并清掉已删除功能遗留的明文凭据字段
void migrateLegacySecrets()

function Root() {
  // 小贴士：这里的改动会让 vite 整页重载（本文件不是 React 热更新边界），
  // 而重载会重新扫描 %APPDATA%\com.infoboard.tauri\plugins —— 也就是说
  // 手动改过插件 manifest 后，保存一次本文件 = 「设置 → 插件管理 → 重新加载插件」。
  const [titleBarVisible, setTitleBarVisible] = useState(true)
  const [logOpen, setLogOpen] = useState(false)
  // 仅用 hash 识别覆盖窗，避免主窗口被误判
  const isOverlay = window.location.hash.startsWith('#/screenshot')

  useEffect(() => {
    const handler = () => setTitleBarVisible((v) => !v)
    window.addEventListener('toggle-titlebar', handler)
    return () => window.removeEventListener('toggle-titlebar', handler)
  }, [])

  useEffect(() => {
    const openLog = () => setLogOpen(true)
    const toggleLog = () => setLogOpen((v) => !v)
    window.addEventListener('log-console-open', openLog)
    window.addEventListener('log-console-toggle', toggleLog)
    return () => {
      window.removeEventListener('log-console-open', openLog)
      window.removeEventListener('log-console-toggle', toggleLog)
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'F12') {
        e.preventDefault()
        // 打包后优先打开应用内日志台；同时尝试原生 DevTools（dev 可用）
        setLogOpen((v) => !v)
        void toggleNativeDevtools()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  if (isOverlay) {
    return <ScreenshotOverlayWindow />
  }

  return (
    <div className={titleBarVisible ? '' : 'titlebar-hidden'}>
      {/* 应用级兜底：组件抛错时不再整窗白屏 */}
      <ErrorBoundary label="主界面">
        <App />
      </ErrorBoundary>
      <GlobalToast />
      <LogConsole open={logOpen} onClose={() => setLogOpen(false)} />
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
)
