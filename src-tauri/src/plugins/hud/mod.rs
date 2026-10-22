//! 网页 HUD：把某个网站装进一个常驻的小窗口
//!
//! 为什么不做成"面板里的 iframe"：
//! - 站点普遍用 `X-Frame-Options` / `frame-ancestors` 拒绝被嵌，iframe 会白屏
//! - 就算能嵌，面板是主窗口的一部分，主窗口一窄（实测 399px），聊天区就只剩一条缝
//!
//! 所以这里开一个**独立的 webview 窗口**直接访问站点首页 —— 等于一个精简浏览器：
//! 登录态在 WebView2 自己的数据目录里，关掉应用也不丢。
//!
//! ## 安全边界
//!
//! 1. URL 是编译期常量，前端只能"按功能打开"，不能传任意地址
//! 2. 只认 https
//! 3. 远端页面**不授予任何 Tauri 权限**（没配 `dangerousRemoteDomainIpcAccess`），
//!    它就是普通网页，调不了 `invoke` —— 这也是为什么 `deepseek-hud` 不在 capabilities 里
//!
//! ## 为什么这里的建窗代码"看起来保守"
//!
//! 上一版点一下就**整个应用无响应**（app.log 停在 `[HUD] 打开 DeepSeek` 之后）。
//! 那次多做了三件别处没做过的事：`restore_state`（window-state 插件会加锁、
//! 还会回调主线程）、从 worker 线程读主窗口几何、以及一个带 `min_inner_size`
//! 和定位的构造链。现在全部收敛成仓库里**已经验证过能工作**的写法
//! （`plugins::translate_grab` 也是 async 命令 + 建窗 + show，实测 3 秒内成功）：
//!
//! - 构造时机不做任何跨线程窗口查询（定位改由前端把窗口几何传进来）
//! - 不碰 `restore_state`
//! - 先 `visible(false)` 建好，再 `show()` —— 避免白屏，也让"建窗"和"显示"两步
//!   在日志里能分开看
//!
//! ## 排查用日志
//!
//! 每一步都写 `app.log`（`[HUD] ①②③`）。如果哪天又卡住，日志会停在最后一步，
//! 6 秒的看门狗还会额外留一条 warn，直接说明"卡在建窗"。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::utils::config::Color;
use tauri::webview::WebviewWindowBuilder;
use tauri::{AppHandle, Manager, WebviewUrl};

/// DeepSeek 网页版
const DEEPSEEK: HudSpec = HudSpec {
    label: "deepseek-hud",
    title: "DeepSeek",
    url: "https://chat.deepseek.com/",
    width: 460.0,
    height: 700.0,
};

struct HudSpec {
    /// 窗口 label：同一 label 只有一个窗口，重复调用就是"唤到前面"
    label: &'static str,
    title: &'static str,
    url: &'static str,
    width: f64,
    height: f64,
}

/// 主窗口几何（由前端传，前端读 `window.screenX/screenY/outerWidth/outerHeight`）。
///
/// 不从 Rust 侧查主窗口是有意的：那需要在 worker 线程上调 `outer_position()`
/// 之类的窗口查询，绕不开跨线程往返；现在这里只做纯数学，零跨线程调用。
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct Anchor {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// 放在主窗口**左侧**；左边不够就放右侧；数值离谱就返回 None（交给 center）
pub fn place_beside(anchor: Anchor, width: f64, height: f64) -> Option<(f64, f64)> {
    let sane = |v: f64, limit: f64| v.is_finite() && v.abs() <= limit;
    if !sane(anchor.x, 20_000.0)
        || !sane(anchor.y, 20_000.0)
        || !sane(anchor.width, 20_000.0)
        || !sane(anchor.height, 20_000.0)
    {
        return None;
    }

    let gap = 12.0;
    let mut x = anchor.x - width - gap;
    if x < 0.0 {
        x = anchor.x + anchor.width + gap;
    }
    let y = (anchor.y + (anchor.height - height) / 2.0).max(0.0);
    Some((x, y))
}

/// 注入到远端页面的"玻璃化"脚本。
///
/// **为什么非得进页面改样式**：透明窗口只能露出「页面没画」的地方，而 DeepSeek 是
/// 标准 SPA —— `body`、`#root`、侧栏、气泡各自都有不透明背景。窗口再怎么透明，
/// 页面上那层白/黑底都会盖住桌面。
///
/// 三条策略，从稳到激进：
/// 1. 根元素铺**半透明玻璃色** + `backdrop-filter`（磨砂），一行就能透出桌面
/// 2. 清掉 `body` / `#root` 的底色，让第 1 条透出来
/// 3. 兜底：扫"铺满视口且不透明"的容器逐个标掉 —— 它换皮肤或改结构时前两条
///    可能失效，第 3 条是泛化的保险（只扫 `body > *` 与 `#root` 前两层，
///    不遍历整棵树，否则流式输出时每次 DOM 变更都要全量算样式，会卡）
///
/// 全部 `!important` + 独立 `<style>`，并用 MutationObserver 在 SPA 路由切换后补挂。
const HUD_GLASS_SCRIPT: &str = r#"
(() => {
  const STYLE_ID = 'infoboard-hud-glass'
  const LAYER_ATTR = 'data-ib-hud-layer'

  const isDark = () => {
    try {
      const de = document.documentElement
      return (
        de.hasAttribute('data-ds-dark-theme') ||
        (document.body && document.body.hasAttribute('data-ds-dark-theme')) ||
        de.getAttribute('data-theme') === 'dark' ||
        window.matchMedia('(prefers-color-scheme: dark)').matches
      )
    } catch (e) {
      return true
    }
  }

  const css = (dark) => `
    html {
      background: ${dark ? 'rgba(18, 18, 20, 0.55)' : 'rgba(250, 250, 252, 0.62)'} !important;
      -webkit-backdrop-filter: blur(18px) saturate(1.15);
      backdrop-filter: blur(18px) saturate(1.15);
    }
    body, #root { background: transparent !important; }
    [${LAYER_ATTR}="1"] { background-color: transparent !important; }
    :root, [data-ds-dark-theme] {
      --dsw-alias-bg-base: transparent !important;
      --dsw-alias-bg-layer-1: ${dark ? 'rgba(28, 28, 32, 0.35)' : 'rgba(255, 255, 255, 0.45)'} !important;
      --dsw-alias-bg-layer-2: ${dark ? 'rgba(36, 36, 42, 0.45)' : 'rgba(255, 255, 255, 0.55)'} !important;
    }
  `

  const mount = () => {
    const head = document.head || document.documentElement
    if (!head) return
    let el = document.getElementById(STYLE_ID)
    if (!el) {
      el = document.createElement('style')
      el.id = STYLE_ID
      head.appendChild(el)
    }
    const next = css(isDark())
    if (el.textContent !== next) el.textContent = next
  }

  const markBigLayers = () => {
    try {
      const viewport = window.innerWidth * window.innerHeight
      if (!viewport) return
      const sels = ['body > *', '#root > *', '#root > * > *']
      for (const sel of sels) {
        document.querySelectorAll(sel).forEach((el) => {
          if (el.hasAttribute(LAYER_ATTR)) return
          const bg = window.getComputedStyle(el).backgroundColor
          if (!bg || bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)') return
          const r = el.getBoundingClientRect()
          if (r.width * r.height >= viewport * 0.6) el.setAttribute(LAYER_ATTR, '1')
        })
      }
    } catch (e) {}
  }

  const apply = () => {
    mount()
    markBigLayers()
  }

  apply()
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', apply, { once: true })
  }

  // SPA 换页 / 换主题后补挂；带防抖，避免流式输出时反复触发
  let timer = 0
  const schedule = () => {
    clearTimeout(timer)
    timer = setTimeout(apply, 400)
  }
  try {
    new MutationObserver(schedule).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-ds-dark-theme', 'data-theme', 'class'],
    })
  } catch (e) {}
})()
"#;

fn open_hud(app: &AppHandle, spec: &HudSpec, anchor: Option<Anchor>) -> Result<(), String> {
    // 已经开着就唤到前面（不重建：重建会丢当前页面状态，也没必要）
    if let Some(win) = app.get_webview_window(spec.label) {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(());
    }

    let url = url::Url::parse(spec.url).map_err(|e| format!("HUD 地址无效: {e}"))?;
    if url.scheme() != "https" {
        return Err(format!("HUD 只支持 https（当前是 {}）", url.scheme()));
    }

    let mut builder = WebviewWindowBuilder::new(app, spec.label, WebviewUrl::External(url))
        .title(spec.title)
        .inner_size(spec.width, spec.height)
        .always_on_top(true)
        .skip_taskbar(true)
        // 先隐藏建好再 show：WebView2 冷启动要几百毫秒到几秒（dev 档更久），
        // 直接可见会先闪一个白框
        .visible(false)
        .focused(false)
        // 磨砂玻璃 HUD：窗口与 webview 两层都要透明（builder 的 transparent
        // 会同时设到 window 和 webview 上），否则页面底下永远是一块不透明画布。
        // 注意 Windows 上 alpha 必须为 0 —— 非 0 的 alpha 会被直接忽略。
        .transparent(true)
        .background_color(Color(0, 0, 0, 0))
        // 远端页面自己会画不透明的底，这里在 document-created 阶段就挂上样式，
        // 把它的底色换成半透明玻璃 + 吃掉铺满视口的不透明层
        .initialization_script(HUD_GLASS_SCRIPT);

    builder = match anchor.and_then(|a| place_beside(a, spec.width, spec.height)) {
        Some((x, y)) => builder.position(x, y),
        None => builder.center(),
    };

    // 看门狗：建窗超过 6 秒还没完成就留一条 warn。
    // 万一又整窗卡死，这条日志能直接把"卡在建窗"钉死，不用再猜。
    let done = Arc::new(AtomicBool::new(false));
    {
        let done = Arc::clone(&done);
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(6)).await;
            if !done.load(Ordering::SeqCst) {
                crate::core::app_log::emit(
                    &app,
                    "warn",
                    "[HUD] 建窗超过 6 秒仍未返回 —— 卡在 WebviewWindowBuilder::build()",
                );
            }
        });
    }

    let started = Instant::now();
    crate::core::app_log::emit(app, "info", "[HUD] ① 开始建窗");

    let win = builder
        .build()
        .map_err(|e| format!("创建 HUD 窗口失败: {e}"))?;
    done.store(true, Ordering::SeqCst);

    crate::core::app_log::emit(
        app,
        "info",
        &format!("[HUD] ② 建窗完成 {}ms", started.elapsed().as_millis()),
    );

    win.show().map_err(|e| format!("显示 HUD 失败: {e}"))?;
    let _ = win.set_focus();

    crate::core::app_log::emit(app, "info", "[HUD] ③ 已显示");
    Ok(())
}

/// 打开 DeepSeek 网页 HUD（插件工具区图标点一下就走这里）
#[tauri::command]
pub async fn hud_open_deepseek(app: AppHandle, anchor: Option<Anchor>) -> Result<(), String> {
    crate::core::app_log::emit(&app, "info", "[HUD] 打开 DeepSeek");
    open_hud(&app, &DEEPSEEK, anchor)
}

/// 自检入口（只在 debug 构建里存在）：和命令走完全相同的 `open_hud`
#[cfg(debug_assertions)]
pub fn debug_open(app: &AppHandle, anchor: Option<Anchor>) -> Result<(), String> {
    open_hud(app, &DEEPSEEK, anchor)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn anchor(x: f64, y: f64, w: f64, h: f64) -> Anchor {
        Anchor {
            x,
            y,
            width: w,
            height: h,
        }
    }

    #[test]
    fn deepseek_spec_is_https_and_sized() {
        assert!(DEEPSEEK.url.starts_with("https://"), "HUD 只应打开 https");
        assert!(
            DEEPSEEK.width >= 360.0 && DEEPSEEK.height >= 480.0,
            "别做成一条缝"
        );
        assert!(!DEEPSEEK.title.is_empty() && !DEEPSEEK.label.is_empty());
    }

    /// label 是窗口唯一键：和主窗口/覆盖窗重名会把它们顶掉
    #[test]
    fn label_does_not_collide_with_core_windows() {
        for taken in ["main", "screenshot-overlay", "translate-capture"] {
            assert_ne!(DEEPSEEK.label, taken, "HUD label 与内置窗口重名: {taken}");
        }
    }

    /// IPC 契约：前端传的是 `{ anchor: { x, y, width, height } }`，
    /// 且 `window.screenX` 这类值可能是**整数**（JSON 里没有小数点）。
    /// 这里钉住反序列化，避免"点一下只弹个类型错误"这种没用日志的失败。
    #[test]
    fn anchor_deserializes_from_frontend_shapes() {
        let floats: Option<Anchor> = serde_json::from_value(serde_json::json!({
            "x": 2146.0, "y": 0.0, "width": 399.0, "height": 1372.0
        }))
        .unwrap();
        assert_eq!(floats.map(|a| a.x), Some(2146.0));

        // 整数形状（JS 里很常见）
        let ints: Option<Anchor> = serde_json::from_value(serde_json::json!({
            "x": 0, "y": 100, "width": 400, "height": 900
        }))
        .unwrap();
        assert_eq!(ints.map(|a| a.width), Some(400.0));

        // 前端没传（旧版插件 / 直接调命令）→ None，交给 center
        let missing: Option<Anchor> = serde_json::from_value(serde_json::Value::Null).unwrap();
        assert!(missing.is_none());
    }

    #[test]
    fn places_to_the_left_when_it_fits() {
        // 主窗口在右侧（x=2146），左边放得下 → 贴在左侧
        let got = place_beside(anchor(2146.0, 0.0, 399.0, 1372.0), 460.0, 700.0).unwrap();
        assert_eq!(got.0, 2146.0 - 460.0 - 12.0);
        // 垂直居中：(1372-700)/2 = 336
        assert_eq!(got.1, 336.0);
    }

    #[test]
    fn falls_back_to_the_right_when_left_is_full() {
        // 主窗口贴左边，左侧放不下 → 换到右侧
        let got = place_beside(anchor(0.0, 100.0, 400.0, 900.0), 460.0, 700.0).unwrap();
        assert_eq!(got.0, 400.0 + 12.0);
        assert_eq!(got.1, 100.0 + (900.0 - 700.0) / 2.0);
    }

    #[test]
    fn rejects_insane_anchors() {
        assert!(place_beside(anchor(f64::NAN, 0.0, 400.0, 800.0), 460.0, 700.0).is_none());
        assert!(place_beside(anchor(0.0, f64::INFINITY, 400.0, 800.0), 460.0, 700.0).is_none());
        assert!(place_beside(anchor(1e9, 0.0, 400.0, 800.0), 460.0, 700.0).is_none());
    }

    /// y 不应该跑到屏幕上方外
    #[test]
    fn clamps_top() {
        let got = place_beside(anchor(1000.0, 0.0, 400.0, 100.0), 460.0, 700.0).unwrap();
        assert_eq!(got.1, 0.0);
    }
}
