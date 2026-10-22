//! 截图模块 — Tauri 后端
//!
//! 对齐 QQ 体验的修复版：
//! 1. xcap 原生截图（优先主显示器）
//! 2. 按需创建覆盖窗（默认 hidden），前端 ready 后再推图并 show
//! 3. close_overlay 统一关窗，与 cancel 语义分离

use std::sync::Mutex;
use std::time::Duration;
use base64::{engine::general_purpose, Engine as _};
use tauri::webview::WebviewWindowBuilder;
use tauri::{AppHandle, Emitter, Listener, Manager, WebviewUrl};

static CAPTURED: Mutex<Option<String>> = Mutex::new(None);

/// 安全获取 CAPTURED 锁；poison 时恢复内部值
fn captured_lock() -> std::sync::MutexGuard<'static, Option<String>> {
    CAPTURED.lock().unwrap_or_else(|e| e.into_inner())
}

const OVERLAY_LABEL: &str = "screenshot-overlay";

/// 截主屏，返回 RGBA 位图（不做编码）
///
/// 与编码分开：`capture_screen_native` 走"截屏 + 编码"两步。
/// （翻译插件的截屏取字在 v2.2 已移除，这里不再有第二个调用方。）
fn capture_screen_rgba() -> Result<image::RgbaImage, String> {
    let monitors = xcap::Monitor::all().map_err(|e| format!("枚举显示器失败: {}", e))?;
    if monitors.is_empty() {
        return Err("未找到显示器".into());
    }

    let monitor = monitors
        .iter()
        .find(|m| m.is_primary().unwrap_or(false))
        .or_else(|| monitors.first())
        .ok_or_else(|| "未找到显示器".to_string())?;

    monitor
        .capture_image()
        .map_err(|e| format!("截图失败: {}", e))
}

fn encode_png_data_url(image: &image::RgbaImage) -> Result<String, String> {
    let mut png_bytes = Vec::new();
    {
        use image::codecs::png::{CompressionType, FilterType, PngEncoder};

        let mut cursor = std::io::Cursor::new(&mut png_bytes);
        // 实测（release）：默认压缩 48ms、Fast 46ms —— 几乎没差，但体积差 600KB。
        // 所以这里一律用默认档，别为了"看起来快"牺牲体积。
        let encoder = PngEncoder::new_with_quality(&mut cursor, CompressionType::Default, FilterType::Sub);
        image
            .write_with_encoder(encoder)
            .map_err(|e| format!("PNG 编码失败: {}", e))?;
    }
    Ok(format!(
        "data:image/png;base64,{}",
        general_purpose::STANDARD.encode(&png_bytes)
    ))
}

/// 优先主显示器，否则第一个；截屏 + 编码成 PNG data URL
pub(crate) fn capture_screen_native() -> Result<String, String> {
    let image = capture_screen_rgba()?;
    encode_png_data_url(&image)
}

/// 仅截图，不建窗（供内部/测试；前端勿与 start 混用）
#[tauri::command]
pub async fn screenshot_capture_only() -> Result<String, String> {
    tokio::task::spawn_blocking(capture_screen_native)
        .await
        .map_err(|e| format!("截图任务失败: {}", e))?
}

#[tauri::command]
pub async fn screenshot_start(app: AppHandle) -> Result<(), String> {
    // 1) 截图
    let data_url = tokio::task::spawn_blocking(capture_screen_native)
        .await
        .map_err(|e| format!("截图任务失败: {}", e))??;
    *captured_lock() = Some(data_url.clone());

    // 2) 关掉旧覆盖窗
    if let Some(old) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = old.close();
        tokio::time::sleep(Duration::from_millis(30)).await;
    }

    // 3) 创建覆盖窗（hidden）
    let overlay = WebviewWindowBuilder::new(
        &app,
        OVERLAY_LABEL,
        WebviewUrl::App("index.html#/screenshot".into()),
    )
    .title("截图")
    .fullscreen(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .decorations(false)
    .resizable(false)
    .visible(false)
    .focused(false)
    .build()
    .map_err(|e| format!("创建覆盖窗口失败: {}", e))?;

    // 4) 等待前端 screenshot:ready（最多 3s），避免 emit 丢失
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<()>();
    let ready_tx = std::sync::Mutex::new(Some(ready_tx));
    let app_for_listen = app.clone();
    let id = app_for_listen.listen("screenshot:ready", move |_event| {
        if let Ok(mut g) = ready_tx.lock() {
            if let Some(tx) = g.take() {
                let _ = tx.send(());
            }
        }
    });

    let ready = tokio::time::timeout(Duration::from_secs(3), ready_rx).await;
    app.unlisten(id);

    // 无论是否收到 ready，都推图 + 兜底 get_image
    overlay
        .emit("screenshot:data", &data_url)
        .map_err(|e| format!("推送截图失败: {}", e))?;

    if ready.is_err() {
        log::warn!("[截图] 未收到 screenshot:ready，仍继续 show（依赖 get_image 兜底）");
        tokio::time::sleep(Duration::from_millis(100)).await;
    } else {
        // 给 React 一帧 setState
        tokio::time::sleep(Duration::from_millis(16)).await;
    }

    overlay
        .show()
        .map_err(|e| format!("显示覆盖窗失败: {}", e))?;
    let _ = overlay.set_focus();
    Ok(())
}

#[tauri::command]
pub fn screenshot_get_image() -> Result<Option<String>, String> {
    Ok(captured_lock().clone())
}

/// 确认：写剪贴板 + 关闭覆盖窗
#[tauri::command]
pub async fn screenshot_confirm(app: AppHandle, data_url: String) -> Result<(), String> {
    let base64_str = data_url
        .split(',')
        .nth(1)
        .ok_or_else(|| "无效 data URL".to_string())?;
    let png = general_purpose::STANDARD
        .decode(base64_str)
        .map_err(|e| format!("base64: {}", e))?;
    let img = image::load_from_memory(&png).map_err(|e| format!("解码: {}", e))?;
    let rgba = img.to_rgba8();
    let (w, h) = rgba.dimensions();
    let mut cb = arboard::Clipboard::new().map_err(|e| format!("剪贴板: {}", e))?;
    cb.set_image(arboard::ImageData {
        width: w as usize,
        height: h as usize,
        bytes: std::borrow::Cow::Owned(rgba.into_raw()),
    })
    .map_err(|e| format!("写入: {}", e))?;

    close_overlay_inner(&app);
    Ok(())
}

/// 取消截图（用户 Esc/取消按钮）
#[tauri::command]
pub async fn screenshot_cancel(app: AppHandle) -> Result<(), String> {
    close_overlay_inner(&app);
    Ok(())
}

/// 仅关闭覆盖窗（浏览器剪贴板已成功时用，语义上不是 cancel）
#[tauri::command]
pub async fn screenshot_close_overlay(app: AppHandle) -> Result<(), String> {
    close_overlay_inner(&app);
    Ok(())
}

fn close_overlay_inner(app: &AppHandle) {
    *captured_lock() = None;
    if let Some(overlay) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = overlay.close();
    }
}
