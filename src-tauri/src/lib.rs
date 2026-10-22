use tauri::Manager;
use tauri_plugin_window_state::{WindowExt, StateFlags};

mod core {
    pub mod app_log;
    pub mod companion;
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
    pub mod apiprobe;
    pub mod bilibili_info;
    pub mod companion;
    pub mod media_control;
    pub mod netdisk;
    pub mod niutrans;
    pub mod screenshot;
    pub mod ocr;
    pub mod loader;
    pub mod pack;
    pub mod webtranslate;
    pub mod hud;
}

/// 调试自检（`INFOBOARD_SELFTEST=1`）：把有卡死风险的窗口路径真跑一遍再退出。
/// 只在 debug 构建里编译，不进发布包。
#[cfg(debug_assertions)]
mod selftest;

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
            // 自检：`INFOBOARD_SELFTEST=1` 时把"点一下会卡死"的路径真的跑一遍再退出
            #[cfg(debug_assertions)]
            if std::env::var("INFOBOARD_SELFTEST").ok().as_deref() == Some("1") {
                selftest::run(app.handle().clone());
            }
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
            // 通用在线翻译（外部插件 translate 用）：openai / deepl / google / mymemory
            plugins::webtranslate::translate_web,
            // 网页 HUD（插件 deepseek 用）：独立窗口直接装站点首页
            plugins::hud::hud_open_deepseek,
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
            // 网盘下载：只负责把独立软件（netdisk-app）拉起来
            plugins::netdisk::app::netdisk_app_status,
            plugins::netdisk::app::netdisk_app_launch,
            // 通用伴随程序启动器（按注册表 id 查，白名单；旧的两组专用命令保留）
            plugins::companion::companion_list,
            plugins::companion::companion_status,
            plugins::companion::companion_launch,
            plugins::companion::companion_set_path,
            plugins::companion::companion_clear_path,
            // API 中转站测活工具（api-probe）：拉起 + 记住入口位置
            plugins::apiprobe::apiprobe_app_status,
            plugins::apiprobe::apiprobe_app_launch,
            plugins::apiprobe::apiprobe_app_set_path,
            plugins::apiprobe::apiprobe_app_clear_path,
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
