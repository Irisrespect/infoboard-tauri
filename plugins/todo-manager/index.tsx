/**
 * 待办详细管理 —— 这个插件**不是**管理页，它只是独立窗口的启动器。
 *
 * ## 为什么这里不放列表 UI
 * 待办数据在宿主的 zustand store（`src/plugins/todo/store.ts`）里，而外置插件由
 * `src/core/pluginRuntime.ts` 用 sucrase 转译后在**受控 require** 里执行，是另一个
 * 模块实例：既 import 不到宿主的 store / utils，也看不到它的运行时状态。把列表搬回
 * 这里只有两条路 —— 复刻一份数据层（两份实现必然分叉：日期解析、排序、逾期判定都得
 * 抄一遍），或者走事件桥（凭空多一层跨窗口协议要维护）。两条都不如让宿主自己开个
 * 窗口直接渲染：管理页在 `src/plugins/todo/TodoManagerWindow.tsx`，开窗命令是 Rust 侧的
 * `todo_window_open`（`src-tauri/src/plugins/todowin/mod.rs`，加载 `index.html#/todo`）。
 * 所以这里只剩一张卡片：不读写待办数据，也不 import 宿主的任何模块。
 *
 * ## 单文件约束（违反就跑不起来）
 * 同其它外置插件：只允许 import `react` / `react/jsx-runtime` / `react-dom` /
 * `@tauri-apps/api/core`；不能拆文件互相 import；样式**全部内联 style** ——
 * `tailwind.config.ts` 的 content 只有 `./index.html` + `./src/**`，`plugins/` 下的类名
 * 不会被生成，写上去等于没写（本文件 0 个类名）。
 *
 * ## 命令白名单
 * `invoke('todo_window_open')` 能否调用取决于 `manifest.json` 的 `tauriCommands`：
 * `pluginRuntime.createPluginModules()` 对没声明的命令直接 reject（fail-closed）。
 * 换命令名时两处要一起改，否则运行时报"插件未声明命令"。
 */

import type { InfoBoardPlugin } from '@/core/types'
import type { CSSProperties } from 'react'
import { useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

/** 开窗命令（与 manifest.tauriCommands、Rust 侧 `todo_window_open` 一致） */
const CMD_OPEN = 'todo_window_open'

const panelStyle: CSSProperties = {
  padding: '14px',
  fontSize: 12,
  color: 'var(--text-primary)',
}

const buttonStyle = (enabled: boolean): CSSProperties => ({
  padding: '9px 18px',
  fontSize: 13,
  fontWeight: 600,
  borderRadius: 6,
  border: '1px solid var(--border-subtle)',
  background: 'var(--accent)',
  color: '#fff',
  cursor: enabled ? 'pointer' : 'not-allowed',
  opacity: enabled ? 1 : 0.6,
})

/** 宿主注入的 toast 通道（`window.toastAPI`，见 `src/types/electron.d.ts`）：只取值，不 import */
interface ToastHost {
  toastAPI?: { show?: (data: { message: string; color?: string }) => void }
}

function showErrorToast(message: string): void {
  if (typeof window === 'undefined') return
  const host = window as unknown as ToastHost
  host.toastAPI?.show?.({ message, color: 'var(--danger)' })
}

/**
 * 启动器卡片
 *
 * 正常路径下它**根本不会被渲染**：工具区点图标是"直接动作"，宿主
 * `src/components/ToolSection.tsx` 的 `togglePlugin` 里对 `todo-manager` 直接 invoke 开窗，
 * 不展开面板。保留 Component 是因为 `InfoBoardPlugin` 要求它有值 —— 万一在旧版本宿主
 * （没有那条分支）里被展开，看到的是这张卡片，而不是一片空白。
 */
function TodoLauncher() {
  const [opening, setOpening] = useState(false)

  const open = () => {
    // 连点两下会去建第二个同 label 的窗口，Tauri 侧直接报"已存在"
    if (opening) return
    setOpening(true)
    void invoke(CMD_OPEN)
      .catch((e: unknown) => {
        showErrorToast('打开待办窗口失败：' + (e instanceof Error ? e.message : String(e)))
      })
      .finally(() => setOpening(false))
  }

  return (
    <div style={panelStyle}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>待办管理</div>
      <div style={{ color: 'var(--text-muted)', lineHeight: 1.8, marginBottom: 12 }}>
        详细管理在独立窗口里进行
      </div>
      <button type="button" style={buttonStyle(!opening)} disabled={opening} onClick={open}>
        {opening ? '打开中…' : '打开窗口'}
      </button>
    </div>
  )
}

const TodoManagerPlugin: InfoBoardPlugin = {
  manifest: {
    id: 'todo-manager',
    name: '待办',
    version: '1.1.0',
    author: 'InfoBoard',
    description: '打开待办详细管理窗口：增删改、筛选、批量清理、撤销',
    section: 'tool',
    icon: 'list-checks',
    color: 'var(--accent)',
  },
  Component: TodoLauncher,
}

export default TodoManagerPlugin
