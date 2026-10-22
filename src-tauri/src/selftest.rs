//! 调试自检（只在 debug 构建里存在）
//!
//! 起因：点 DeepSeek 图标会导致**整个应用无响应**。GUI 里的"点一下"没法自动测，
//! 所以这里把那条路径原样跑一遍 —— 用的是真 app、真窗口、真 WebView2，
//! 只是把"用户点击"换成一次函数调用。
//!
//! 跑法：
//! ```powershell
//! $env:INFOBOARD_SELFTEST='1'; cargo run --manifest-path src-tauri/Cargo.toml
//! ```
//! 结果打到 stderr，最后 `std::process::exit`，不会留后台进程。
//!
//! 目前只覆盖 `plugins::hud::open_hud`（那条会卡死的路径）。
//! 翻译插件的截屏取字在 v2.2 已移除，对应的 `translate_grab` 自检也一起去掉了。

use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

pub fn run(app: AppHandle) {
    // 看门狗：任何一步卡死都要能给出结论并退出
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_secs(30));
        eprintln!("[selftest] ❌ 30 秒未完成 —— 卡在上面最后一条日志之后的调用里");
        std::process::exit(9);
    });

    std::thread::spawn(move || {
        eprintln!("[selftest] hud::open_hud（anchor 模拟主窗口在屏幕右侧）");
        let t = Instant::now();
        let hud = crate::plugins::hud::debug_open(
            &app,
            Some(crate::plugins::hud::Anchor {
                x: 2146.0,
                y: 0.0,
                width: 399.0,
                height: 1372.0,
            }),
        );
        eprintln!(
            "[selftest] open_hud 返回 ok={} 用时 {:?}",
            hud.is_ok(),
            t.elapsed()
        );
        if let Err(e) = &hud {
            eprintln!("[selftest] 失败原因: {e}");
        }

        // 给它两秒把远端页面拉起来，再看窗口状态
        std::thread::sleep(Duration::from_secs(2));
        match app.get_webview_window("deepseek-hud") {
            Some(w) => eprintln!(
                "[selftest] 窗口存在 · visible={:?} · url={:?}",
                w.is_visible().unwrap_or(false),
                w.url().map(|u| u.to_string())
            ),
            None => eprintln!("[selftest] ❌ 窗口不存在"),
        }

        if let Some(win) = app.get_webview_window("deepseek-hud") {
            let _ = win.close();
        }
        eprintln!("[selftest] ✓ 完成");
        std::process::exit(0);
    });
}
