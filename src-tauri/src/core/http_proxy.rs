//! 前端 HTTP 代理（绕过 WebView CSP）
//!
//! - 仅允许白名单域名
//! - 代理策略见 `core::net`：只用环境变量代理（有则优先、失败后直连兜底），
//!   不再硬编码本机常见代理端口

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

fn host_allowed(host: &str) -> bool {
    let h = host.to_ascii_lowercase();
    ALLOWED_HOST_SUFFIXES
        .iter()
        .any(|suf| h == *suf || h.ends_with(&format!(".{suf}")))
}

/// 和风天气域名（占位符只允许出现在这些域名的请求里）
fn is_qweather_host(host: &str) -> bool {
    let h = host.to_ascii_lowercase();
    ["qweather.com", "qweatherapi.com", "heweather.net"]
        .iter()
        .any(|suf| h == *suf || h.ends_with(&format!(".{suf}")))
}

/// 前端请求 URL 里的和风 Key 占位符。
/// 前端不再持有明文 Key，发请求前由这里替换。
pub const QWEATHER_KEY_PLACEHOLDER: &str = "{{QWEATHER_KEY}}";

/// 是否要注入 Key（纯函数，便于测试）
#[derive(Debug, PartialEq, Eq)]
pub enum KeyInjection {
    /// URL 里没有占位符，原样发出
    NotNeeded,
    /// 有占位符且域名是和风，允许注入
    Allowed,
    /// 有占位符但域名不是和风，必须拒绝（否则 Key 会被带到别的域名）
    HostNotAllowed,
}

pub fn decide_key_injection(url: &str, host: &str) -> KeyInjection {
    if !url.contains(QWEATHER_KEY_PLACEHOLDER) {
        return KeyInjection::NotNeeded;
    }
    if !is_qweather_host(host) {
        return KeyInjection::HostNotAllowed;
    }
    KeyInjection::Allowed
}

/// 把 URL 里的 `{{QWEATHER_KEY}}` 换成凭据库里的和风 Key。
///
/// - 没有占位符 → 原样返回（例如 bilibili / 其它白名单域名）
/// - 有占位符但域名不是和风 → 拒绝
/// - 没配置 Key → 明确报错，而不是发一个必然 401 的请求
fn inject_qweather_key(app: &AppHandle, url: &str, host: &str) -> Result<String, String> {
    match decide_key_injection(url, host) {
        KeyInjection::NotNeeded => Ok(url.to_string()),
        KeyInjection::HostNotAllowed => {
            let msg = format!("[http_proxy] 拒绝在和风以外的域名使用 Key 占位符: {host}");
            crate::core::app_log::emit(app, "warn", &msg);
            Err(format!("域名不允许使用天气 API Key: {host}"))
        }
        KeyInjection::Allowed => {
            let key = crate::core::secrets::get(crate::core::secrets::NAME_QWEATHER)?
                .unwrap_or_default()
                .trim()
                .to_string();
            if key.is_empty() {
                return Err("未配置和风天气 API Key（设置 → 天气 API）".into());
            }
            Ok(url.replace(QWEATHER_KEY_PLACEHOLDER, &key))
        }
    }
}

fn build_client(proxy: Option<&str>) -> Result<reqwest::Client, String> {
    let mut b = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(10))
        .user_agent("InfoBoard/0.1 (Tauri)")
        // 默认会跟随 10 跳重定向且不再校验域名，可借白名单站点跳转访问内网；
        // 这里每一跳都重新校验白名单
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 {
                return attempt.error("重定向次数过多");
            }
            let allowed = attempt.url().host_str().map(host_allowed).unwrap_or(false);
            if allowed {
                attempt.follow()
            } else {
                attempt.error("重定向目标不在白名单")
            }
        }));

    if let Some(p) = proxy {
        let proxy = reqwest::Proxy::all(p).map_err(|e| {
            let sanitized = sanitize_proxy_for_log(p);
            format!("代理无效 ({sanitized}): {e}")
        })?;
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
        // reqwest 的错误文本默认带完整 URL（含查询串里的 API Key），必须去掉
        .map_err(|e| format!("网络错误: {}", e.without_url()))?;

    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取 body 失败: {}", e.without_url()))?;

    if !status.is_success() {
        let preview: String = text.chars().take(160).collect();
        return Err(format!("HTTP {} {}", status.as_u16(), preview));
    }
    Ok(text)
}

/// 从代理 URL 剥离用户信息（user:pass@），只留 scheme://host:port
fn sanitize_proxy_for_log(proxy: &str) -> String {
    if let Ok(mut u) = url::Url::parse(proxy) {
        let _ = u.set_username("");
        let _ = u.set_password(None);
        u.to_string()
    } else {
        "[解析失败]".to_string()
    }
}

/// GET 请求并返回响应文本
#[tauri::command]
pub async fn http_proxy_get(app: AppHandle, url: String) -> Result<String, String> {
    let parsed = url::Url::parse(&url).map_err(|e| format!("URL 无效: {e}"))?;
    if parsed.scheme() != "https" {
        return Err("仅支持 https（明文 http 被拒绝）".into());
    }
    let host = parsed.host_str().ok_or_else(|| "缺少 host".to_string())?.to_string();
    if !host_allowed(&host) {
        let msg = format!("[http_proxy] 拒绝非白名单域名: {host}");
        crate::core::app_log::emit(&app, "warn", &msg);
        return Err(format!("域名不在白名单: {host}"));
    }

    // 只在发请求前替换占位符；日志/错误里只用替换前的 URL
    let url_with_key = inject_qweather_key(&app, &url, &host)?;

    // 二次解析，确保替换后仍指向白名单
    let parsed_final = url::Url::parse(&url_with_key).map_err(|e| format!("替换后 URL 无效: {e}"))?;
    if parsed_final.scheme() != "https" {
        return Err("Key 替换后 scheme 必须为 https".into());
    }
    let host_final = parsed_final
        .host_str()
        .ok_or_else(|| "替换后缺少 host".to_string())?
        .to_string();
    if !host_allowed(&host_final) {
        return Err(format!("Key 替换后域名不在白名单: {host_final}"));
    }

    // 尝试顺序由 core::net 决定：环境变量代理优先（有的话），否则只直连。
    // 不再追加本机常见代理端口。
    let attempts: Vec<Option<String>> =
        crate::core::net::build_attempts(crate::core::net::env_proxy());

    let mut last_err = String::from("未知错误");
    for (i, proxy) in attempts.iter().enumerate() {
        // 从代理 URL 剥离凭据再用作标签
        let label = proxy
            .as_deref()
            .map(sanitize_proxy_for_log)
            .unwrap_or_else(|| "直连".to_string());
        let client = match build_client(proxy.as_deref()) {
            Ok(c) => c,
            Err(e) => {
                last_err = e;
                continue;
            }
        };
        match do_get(&client, &url_with_key).await {
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 回归：reqwest 错误默认带完整 URL，查询串里的 API Key 不应出现在错误文本中
    #[tokio::test]
    async fn test_no_api_key_in_error() {
        let client = reqwest::Client::new();
        let err = do_get(&client, "https://httpbin.org/status/500?key=SECRET123")
            .await
            .unwrap_err();
        assert!(!err.contains("SECRET"), "错误里不应出现查询串: {err}");
    }

    #[test]
    fn test_host_allowed() {
        assert!(host_allowed("devapi.qweather.com"));
        assert!(host_allowed("api.bilibili.com"));
        assert!(!host_allowed("evil.com"));
    }

    #[test]
    fn test_key_injection_decision() {
        assert_eq!(
            decide_key_injection("https://devapi.qweather.com/v7/weather/now", "devapi.qweather.com"),
            KeyInjection::NotNeeded
        );
        assert_eq!(
            decide_key_injection(
                "https://devapi.qweather.com/v7/weather/now?key={{QWEATHER_KEY}}",
                "devapi.qweather.com"
            ),
            KeyInjection::Allowed
        );
        assert_eq!(
            decide_key_injection("https://evil.com?key={{QWEATHER_KEY}}", "evil.com"),
            KeyInjection::HostNotAllowed
        );
    }
}
