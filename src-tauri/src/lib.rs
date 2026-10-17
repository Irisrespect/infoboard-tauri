use tauri::Manager;
use tauri_plugin_window_state::{WindowExt, StateFlags};

mod core {
    pub mod app_log;
    pub mod http_proxy;
    pub mod autostart;
    pub mod geolocate;
    pub mod net;
    pub mod secrets;
    pub mod text;
    pub mod tray;
    pub mod window;
}

mod plugins {
    pub mod bilibili_info;
    pub mod media_control;
    pub mod niutrans;
    pub mod screenshot;
    pub mod ocr;
    pub mod loader;
    pub mod pack;
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // 必须最先注册：二次启动（如开机自启后又双击）只唤起已有窗口，不再双开
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            println!("[单实例] 检测到重复启动，唤起已有窗口");
            if let Some(window) = app.get_webview_window("main") {
                core::window::show_and_focus(&window);
            }
        }))
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        // 「设置 → 插件管理 → 选择插件包」用系统文件选择器
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None::<Vec<&'static str>>,
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        println!("[快捷键] Ctrl+Shift+I 触发");
                        // 切换主窗口显隐（show/hide 内部会 emit window:visibility 通知前端）
                        if let Some(window) = app.get_webview_window("main") {
                            core::window::toggle_main_window(&window, "快捷键");
                        }
                    }
                })
                .build(),
        )
        .manage(plugins::media_control::AppState::new())
        .setup(|app| {
            println!("[系统] InfoBoard 启动");
            core::app_log::emit(app.handle(), "info", "[系统] InfoBoard 启动 · 后端日志已接入日志台");
            core::tray::setup_tray(app.handle())?;
            // 恢复上次关闭时的窗口大小和位置
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.restore_state(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED);
                // 托盘应用：不在任务栏显示图标
                let _ = window.set_skip_taskbar(true);
            }
            // 注册全局快捷键 Ctrl+Shift+I
            {
                use tauri_plugin_global_shortcut::GlobalShortcutExt;
                // 失败（被别的程序占用）时功能会静默消失，必须留下痕迹
                if let Err(e) = app.global_shortcut().register("Ctrl+Shift+I") {
                    core::app_log::emit(
                        app.handle(),
                        "warn",
                        &format!("[快捷键] Ctrl+Shift+I 注册失败（可能被其它程序占用）: {e}"),
                    );
                }
            }
            // 注册插件状态
            app.manage(plugins::ocr::OcrEngine::new());
            // 清理上次安装/卸载中断留下的临时目录（.installing-* / .replacing-* / .uninstalled-*）
            if let Ok(dir) = plugins::loader::plugins_dir(app.handle()) {
                plugins::pack::cleanup_stale_dirs(&dir);
            }
            // P1-a：把历史明文 API Key 迁到 Windows 凭据管理器
            plugins::niutrans::migrate_legacy_api_key(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            core::app_log::log_get_path,
            core::app_log::log_append_file,
            core::http_proxy::http_proxy_get,
            core::secrets::secret_set,
            core::secrets::secret_has,
            core::secrets::secret_delete,
            core::autostart::autostart_is_enabled,
            core::autostart::autostart_set_enabled,
            core::window::window_minimize,
            core::window::window_maximize,
            core::window::window_close,
            core::window::window_is_active,
            core::window::window_is_maximized,
            core::window::window_is_visible,
            core::geolocate::geolocate_ip,
            plugins::bilibili_info::bilibili_enrich_media,
            plugins::media_control::media_get_current_session,
            plugins::media_control::media_send_command,
            plugins::niutrans::niutrans_translate,
            plugins::niutrans::niutrans_set_api_key,
            plugins::niutrans::niutrans_set_app_id,
            plugins::niutrans::niutrans_has_api_key,
            plugins::niutrans::niutrans_get_config,
            plugins::niutrans::niutrans_get_char_count,
            // Issue 14: 截图
            plugins::screenshot::screenshot_start,
            plugins::screenshot::screenshot_capture_only,
            plugins::screenshot::screenshot_get_image,
            plugins::screenshot::screenshot_confirm,
            plugins::screenshot::screenshot_cancel,
            plugins::screenshot::screenshot_close_overlay,
            // Issue 15: OCR
            plugins::ocr::ocr_recognize,
            plugins::ocr::ocr_is_ready,
            plugins::ocr::ocr_engine_status,
            // Issue 16: IMAP 邮件
            // 外部插件加载器
            plugins::loader::scan_external_plugins,
            plugins::loader::read_external_plugin_source,
            // 插件包导入 / 卸载
            plugins::pack::install_plugin_package_cmd,
            plugins::pack::list_installed_plugins,
            plugins::pack::uninstall_plugin,
            plugins::pack::purge_uninstalled_plugin,
        ])
        .build(tauri::generate_context!())
        .expect("启动 InfoBoard 失败");

    app.run(core::tray::handle_run_event);
}
