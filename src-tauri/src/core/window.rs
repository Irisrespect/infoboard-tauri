use tauri::WebviewWindow;

#[derive(Debug, PartialEq, Eq)]
pub enum ToggleAction {
    Hide,
    Show,
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

/// 显示窗口：先解除最小化（show() 不会还原最小化态），再显示并聚焦
pub fn show_and_focus(window: &WebviewWindow) {
    let _ = window.set_skip_taskbar(true);
    if window.is_minimized().unwrap_or(false) {
        let _ = window.unminimize();
    }
    let _ = window.show();
    let _ = window.set_focus();
}

/// 切换主窗口显隐（托盘菜单 / 托盘单击 / 全局快捷键共用）
pub fn toggle_main_window(window: &WebviewWindow, origin: &str) {
    let visible = window.is_visible().unwrap_or(false);
    let minimized = window.is_minimized().unwrap_or(false);
    match decide_toggle(visible, minimized) {
        ToggleAction::Hide => {
            println!("[{origin}] 隐藏窗口");
            let _ = window.set_skip_taskbar(true);
            let _ = window.hide();
        }
        ToggleAction::Show => {
            println!("[{origin}] 显示窗口 (minimized={minimized})");
            show_and_focus(window);
        }
    }
}

#[tauri::command]
pub fn window_minimize(window: WebviewWindow) -> Result<(), String> {
    println!("[窗口] 最小化");
    window.minimize().map_err(|e| e.to_string())
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
    let _ = window.set_skip_taskbar(true);
    window.hide().map_err(|e| e.to_string())
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
