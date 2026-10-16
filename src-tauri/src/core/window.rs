use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, WebviewWindow};

#[derive(Debug, PartialEq, Eq)]
pub enum ToggleAction {
    Hide,
    Show,
}

/// 主窗口对用户是否"活跃"（可见且未最小化）。
///
/// 为什么需要它：窗口 `hide()` 到托盘后，WebView 里的
/// `document.visibilityState` 仍然是 `visible`、也没有 `visibilitychange` 事件
/// （已在真实 WebView2 里实测），前端无法自行判断窗口是否在后台，
/// 于是隐藏后仍在每 2 秒起一个 `powershell.exe` 查 SMTC。这里由 Rust 记录状态，
/// 并通过 `window:visibility` 事件主动通知前端。
static MAIN_ACTIVE: AtomicBool = AtomicBool::new(true);

/// 供 `window_is_active` 命令读取的当前值
pub fn is_main_active() -> bool {
    MAIN_ACTIVE.load(Ordering::SeqCst)
}

/// 记录状态并通知前端（值未变化时不重复发事件）
fn set_active(window: &WebviewWindow, active: bool) {
    let previous = MAIN_ACTIVE.swap(active, Ordering::SeqCst);
    if previous != active {
        let _ = window.emit("window:visibility", active);
    }
}

/// 显隐主窗口的**唯一**入口：执行 hide/show、更新全局状态、通知前端。
/// 托盘菜单/托盘单击/全局快捷键/标题栏关闭按钮/单实例唤起都必须走这里，
/// 否则前端拿到的活跃状态会和真实窗口状态不一致。
pub fn set_main_visible(window: &WebviewWindow, visible: bool) {
    if visible {
        // show() 不会还原最小化态，必须先解除最小化
        if window.is_minimized().unwrap_or(false) {
            let _ = window.unminimize();
        }
        let _ = window.set_skip_taskbar(true);
        let _ = window.show();
        let _ = window.set_focus();
    } else {
        let _ = window.set_skip_taskbar(true);
        let _ = window.hide();
    }
    set_active(window, visible);
}

/// 最小化：对前端而言同样属于"不可见"，停止轮询
pub fn set_main_minimized(window: &WebviewWindow, minimized: bool) {
    set_active(window, !minimized);
}

/// 按窗口当前的真实状态同步活跃标志（不动窗口本身）。
/// 用于"最小化后被系统/用户还原"这类不是由本模块发起的显隐变化。
pub fn sync_main_active(window: &WebviewWindow) {
    let active = window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(false);
    set_active(window, active);
}

/// 决定切换动作。Windows 上最小化的窗口 `is_visible()` 仍为 true，
/// 若只看 visible 会把"最小化"当成"已显示"而再次隐藏，永远还原不了。
pub fn decide_toggle(visible: bool, minimized: bool) -> ToggleAction {
    if visible && !minimized {
        ToggleAction::Hide
    } else {
        ToggleAction::Show
    }
}

/// 显示窗口：先解除最小化（show() 不会还原最小化态），再显示并聚焦。
/// 保留该函数名作为语义化封装，实际动作统一走 `set_main_visible`。
pub fn show_and_focus(window: &WebviewWindow) {
    set_main_visible(window, true);
}

/// 切换主窗口显隐（托盘菜单 / 托盘单击 / 全局快捷键共用）
pub fn toggle_main_window(window: &WebviewWindow, origin: &str) {
    let visible = window.is_visible().unwrap_or(false);
    let minimized = window.is_minimized().unwrap_or(false);
    match decide_toggle(visible, minimized) {
        ToggleAction::Hide => {
            println!("[{origin}] 隐藏窗口");
            set_main_visible(window, false);
        }
        ToggleAction::Show => {
            println!("[{origin}] 显示窗口 (minimized={minimized})");
            set_main_visible(window, true);
        }
    }
}

#[tauri::command]
pub fn window_minimize(window: WebviewWindow) -> Result<(), String> {
    println!("[窗口] 最小化");
    window.minimize().map_err(|e| e.to_string())?;
    // 最小化后前端不该继续轮询（隐藏到托盘同一路径）
    set_main_minimized(&window, true);
    Ok(())
}

#[tauri::command]
pub fn window_maximize(window: WebviewWindow) -> Result<(), String> {
    if window.is_maximized().unwrap_or(false) {
        println!("[窗口] 恢复");
        window.unmaximize().map_err(|e| e.to_string())
    } else {
        println!("[窗口] 最大化");
        window.maximize().map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn window_close(window: WebviewWindow) -> Result<(), String> {
    println!("[窗口] 隐藏到托盘");
    set_main_visible(&window, false);
    Ok(())
}

/// 前端启动时取活跃状态初值；之后由 `window:visibility` 事件更新
#[tauri::command]
pub fn window_is_active() -> bool {
    is_main_active()
}

#[tauri::command]
pub fn window_is_maximized(window: WebviewWindow) -> Result<bool, String> {
    let maximized = window.is_maximized().map_err(|e| e.to_string())?;
    println!("[窗口] 查询最大化状态: {}", maximized);
    Ok(maximized)
}

#[tauri::command]
pub fn window_is_visible(window: WebviewWindow) -> Result<bool, String> {
    let visible = window.is_visible().map_err(|e| e.to_string())?;
    println!("[窗口] 查询可见状态: {}", visible);
    Ok(visible)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn visible_normal_window_is_hidden() {
        assert_eq!(decide_toggle(true, false), ToggleAction::Hide);
    }

    #[test]
    fn hidden_window_is_shown() {
        assert_eq!(decide_toggle(false, false), ToggleAction::Show);
    }

    /// 回归：最小化窗口 is_visible()==true，必须还原而不是再次隐藏
    #[test]
    fn minimized_window_is_restored_not_hidden() {
        assert_eq!(decide_toggle(true, true), ToggleAction::Show);
    }

    #[test]
    fn hidden_and_minimized_is_shown() {
        assert_eq!(decide_toggle(false, true), ToggleAction::Show);
    }
}
