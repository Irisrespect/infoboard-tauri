use tauri::{
    Manager,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, RunEvent,
};

pub fn setup_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let show_hide = MenuItem::with_id(app, "show_hide", "显示/隐藏", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_hide, &quit])?;

    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or("未找到默认窗口图标")?;

    TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "show_hide" => {
                if let Some(window) = app.get_webview_window("main") {
                    super::window::toggle_main_window(&window, "托盘菜单");
                }
            }
            "quit" => {
                println!("[托盘] 菜单 → 退出应用");
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    super::window::toggle_main_window(&window, "托盘单击");
                }
            }
        })
        .build(app)?;

    println!("[托盘] 系统托盘已创建");
    Ok(())
}

pub fn handle_run_event(app: &AppHandle, event: RunEvent) {
    if let RunEvent::WindowEvent { label, event: win_event, .. } = &event {
        if label == "main" {
            match win_event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    println!("[窗口] 关闭按钮 → 拦截并隐藏到托盘");
                    api.prevent_close();
                    if let Some(window) = app.get_webview_window("main") {
                        // 与 window_close 同一路径：更新活跃标志并通知前端停止轮询
                        super::window::set_main_visible(&window, false);
                    }
                }
                // 安全网：最小化后若不是由本应用还原的（例如从系统任务栏还原），
                // 也要把活跃标志同步回来，否则前端会一直不轮询
                tauri::WindowEvent::Focused(true) => {
                    if let Some(window) = app.get_webview_window("main") {
                        super::window::sync_main_active(&window);
                    }
                }
                _ => {}
            }
        }
    }
}
