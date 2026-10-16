//! 前端 HTTP 代理（绕过 WebView CSP）
//!
//! - 仅允许白名单域名
//! - 支持环境变量代理，并在直连失败时尝试本机常见代理端口

use std::time::Duration;
use tauri::AppHandle;

const ALLOWED_HOST_SUFFIXES: &[&str] = &[
    "qweather.com",
    "qweatherapi.com",
    "heweather.net",
    "api.bilibili.com",
    "search.bilibili.com",
    "hdslb.com",
    "niutrans.com",
    "open-meteo.com",
];

/// 本机常见代理（Clash / v2rayN 等）
const LOCAL_PROXY_CANDIDATES: &[&str] = &[
    "http://127.0.0.1:7897",
    "http://127.0.0.1:7890",
    "http://127.0.0.1:10809",
    "http://127.0.0.1:1080",
];

fn host_allowed(host: &str) -> bool {
    let h = host.to_ascii_lowercase();
    ALLOWED_HOST_SUFFIXES
        .iter()
        .any(|suf| h == *suf || h.ends_with(&format!(".{suf}")))
}

fn env_proxy() -> Option<String> {
    std::env::var("HTTPS_PROXY")
        .or_else(|_| std::env::var("https_proxy"))
        .or_else(|_| std::env::var("HTTP_PROXY"))
        .or_else(|_| std::env::var("http_proxy"))
        .or_else(|_| std::env::var("ALL_PROXY"))
        .or_else(|_| std::env::var("all_proxy"))
        .ok()
        .filter(|s| !s.trim().is_empty())
}

fn build_client(proxy: Option<&str>) -> Result<reqwest::Client, String> {
    let mut b = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(10))
        .user_agent("InfoBoard/0.1 (Tauri)");

    if let Some(p) = proxy {
        let proxy = reqwest::Proxy::all(p).map_err(|e| format!("代理无效 ({p}): {e}"))?;
        b = b.proxy(proxy);
    } else {
        // 明确禁用系统自动探测失败时的怪异行为：无代理直连
        b = b.no_proxy();
    }

    b.build().map_err(|e| format!("HTTP 客户端失败: {e}"))
}

async fn do_get(client: &reqwest::Client, url: &str) -> Result<String, String> {
    // 显式声明可接受压缩；reqwest 开启 gzip/brotli/deflate feature 后会自动解压
    let resp = client
        .get(url)
        .header("Accept", "application/json, text/plain, */*")
        .header("Accept-Encoding", "gzip, deflate, br")
        .send()
        .await
        .map_err(|e| format!("网络错误: {e}"))?;

    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取 body 失败: {e}"))?;

    if !status.is_success() {
        let preview: String = text.chars().take(160).collect();
        return Err(format!("HTTP {} {}", status.as_u16(), preview));
    }
    Ok(text)
}

/// GET 请求并返回响应文本
#[tauri::command]
pub async fn http_proxy_get(app: AppHandle, url: String) -> Result<String, String> {
    let parsed = url::Url::parse(&url).map_err(|e| format!("URL 无效: {e}"))?;
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return Err("仅支持 http/https".into());
    }
    let host = parsed.host_str().ok_or_else(|| "缺少 host".to_string())?;
    if !host_allowed(host) {
        let msg = format!("[http_proxy] 拒绝非白名单域名: {host}");
        crate::core::app_log::emit(&app, "warn", &msg);
        return Err(format!("域名不在白名单: {host}"));
    }

    // 1) 环境变量代理优先
    // 2) 无环境变量则先直连
    // 3) 直连失败再试本机常见代理
    let mut attempts: Vec<Option<String>> = Vec::new();
    if let Some(p) = env_proxy() {
        attempts.push(Some(p));
    }
    attempts.push(None); // 直连
    for p in LOCAL_PROXY_CANDIDATES {
        let s = p.to_string();
        if !attempts.iter().any(|a| a.as_deref() == Some(s.as_str())) {
            attempts.push(Some(s));
        }
    }

    let mut last_err = String::from("未知错误");
    for (i, proxy) in attempts.iter().enumerate() {
        let label = proxy.as_deref().unwrap_or("直连");
        let client = match build_client(proxy.as_deref()) {
            Ok(c) => c,
            Err(e) => {
                last_err = e;
                continue;
            }
        };
        match do_get(&client, &url).await {
            Ok(text) => {
                if i > 0 {
                    crate::core::app_log::emit(
                        &app,
                        "info",
                        &format!("[http_proxy] 成功 via {label} host={host}"),
                    );
                }
                return Ok(text);
            }
            Err(e) => {
                last_err = format!("{label}: {e}");
                crate::core::app_log::emit(
                    &app,
                    "debug",
                    &format!("[http_proxy] 尝试失败 ({label}): {e}"),
                );
            }
        }
    }

    let msg = format!("[http_proxy] 全部尝试失败 host={host} err={last_err}");
    crate::core::app_log::emit(&app, "error", &msg);
    Err(last_err)
}
