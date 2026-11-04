//! 待办详细管理窗口（独立窗口，`index.html#/todo`）
//!
//! 待办的「详细管理」（增删改、筛选、批量清理）原来挤在工具区的内嵌面板里，
//! 与外置插件 `plugins/todo-manager` 共用同一份 localStorage。改成独立窗口后：
//!
//! - 工具区只留一个图标入口，点一下**弹出自己的窗**（和 api-probe 那类工具一致）
//! - 窗口与主窗口**同源**，所以两边读写的 `todo-list` 是同一份数据，
//!   跨窗口同步交给浏览器原生的 `storage` 事件（见 `src/plugins/todo/store.ts`）
//!
//! 建窗范式与 `plugins::screenshot::screenshot_start` 一致：`WebviewUrl::App`
//! 指向同一个 `index.html`，靠 hash 路由（`#/todo`）区分要渲染哪个页面。

use tauri::webview::WebviewWindowBuilder;
use tauri::{AppHandle, Manager, WebviewUrl};

/// 窗口 label：既是 Tauri 侧的窗口标识，也是"已经开着就聚焦"的查找键
pub const LABEL: &str = "todo-manager";

/// 打开待办详细管理窗口；已存在则聚焦（不重复建窗）
///
/// 重复点击工具区图标时**必须**走聚焦分支：再建一个同 label 的窗会直接失败，
/// 而用户看到的是"点了没反应"（旧窗口可能被别的窗口挡住或在后台）。
#[tauri::command]
pub async fn todo_window_open(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("index.html#/todo".into()))
        .title("待办")
        .inner_size(520.0, 700.0)
        .min_inner_size(400.0, 460.0)
        .decorations(true)
        .center()
        .build()
        .map_err(|e| format!("打开待办窗口失败: {e}"))?;
    Ok(())
}
