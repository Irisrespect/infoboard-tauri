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

/// GET 请求并返回响应文本
#[tauri::command]
pub async fn http_proxy_get(app: AppHandle, url: String) -> Result<String, String> {
    let parsed = url::Url::parse(&url).map_err(|e| format!("URL 无效: {e}"))?;
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return Err("仅支持 http/https".into());
    }
    let host = parsed.host_str().ok_or_else(|| "缺少 host".to_string())?.to_string();
    if !host_allowed(&host) {
        let msg = format!("[http_proxy] 拒绝非白名单域名: {host}");
        crate::core::app_log::emit(&app, "warn", &msg);
        return Err(format!("域名不在白名单: {host}"));
    }

    // 只在发请求前替换占位符；日志/错误里只用替换前的 URL
    let url = inject_qweather_key(&app, &url, &host)?;

    // 尝试顺序由 core::net 决定：环境变量代理优先（有的话），否则只直连。
    // 不再追加本机常见代理端口。
    let attempts: Vec<Option<String>> = crate::core::net::build_attempts(crate::core::net::env_proxy());

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

#[cfg(test)]
mod tests {
    use super::*;

    /// 回归：reqwest 错误默认带完整 URL，查询串里的 API Key 不应出现在错误文本中
    #[tokio::test]
    async fn network_error_does_not_leak_api_key() {
        let client = build_client(None).unwrap();
        // 端口 1 本机必然拒绝连接，产生真实的 reqwest 网络错误
        let err = do_get(&client, "http://127.0.0.1:1/geo/v2/city/lookup?location=1,2&key=SECRETKEY123")
            .await
            .unwrap_err();
        assert!(!err.contains("SECRETKEY123"), "错误文本泄漏了 Key: {err}");
    }

    #[test]
    fn host_allowed_checks_suffix_boundary() {
        assert!(host_allowed("devapi.qweather.com"));
        assert!(host_allowed("qweather.com"));
        assert!(!host_allowed("evilqweather.com"));
        assert!(!host_allowed("127.0.0.1"));
    }

    #[test]
    fn qweather_host_detection() {
        assert!(is_qweather_host("devapi.qweather.com"));
        assert!(is_qweather_host("abc123.qweatherapi.com"));
        assert!(is_qweather_host("api.heweather.net"));
        assert!(!is_qweather_host("api.bilibili.com"));
        assert!(!is_qweather_host("evilqweather.com"));
    }

    /// 没有占位符时不得触碰凭据库（bilibili 等请求不该因此报错）
    #[test]
    fn injection_not_needed_without_placeholder() {
        let url = "https://api.bilibili.com/x/web-interface/view?bvid=BV1xx";
        assert_eq!(decide_key_injection(url, "api.bilibili.com"), KeyInjection::NotNeeded);
    }

    #[test]
    fn injection_allowed_for_qweather_host() {
        let url = format!(
            "https://devapi.qweather.com/v7/weather/now?location=101010100&key={QWEATHER_KEY_PLACEHOLDER}&lang=zh"
        );
        assert_eq!(decide_key_injection(&url, "devapi.qweather.com"), KeyInjection::Allowed);
        assert_eq!(decide_key_injection(&url, "abc.qweatherapi.com"), KeyInjection::Allowed);
    }

    /// 安全：占位符出现在非和风域名上时必须拒绝，否则 Key 会被带到别的站点
    #[test]
    fn injection_rejected_on_other_hosts() {
        let url = format!("https://api.bilibili.com/x?key={QWEATHER_KEY_PLACEHOLDER}");
        assert_eq!(decide_key_injection(&url, "api.bilibili.com"), KeyInjection::HostNotAllowed);
        // 仿冒域名同样拒绝
        assert_eq!(
            decide_key_injection(&url, "evilqweather.com"),
            KeyInjection::HostNotAllowed
        );
    }

    /// 前端传的是未编码的原始 URL（含花括号），替换要在原串上做，
    /// 不能被 url crate 的百分号编码影响
    #[test]
    fn placeholder_survives_url_parsing() {
        let raw = format!(
            "https://devapi.qweather.com/v7/weather/now?location=101010100&key={QWEATHER_KEY_PLACEHOLDER}&lang=zh"
        );
        let parsed = url::Url::parse(&raw).expect("应能解析");
        assert_eq!(parsed.host_str(), Some("devapi.qweather.com"));
        // 原串保持不变，替换后不含花括号
        assert!(raw.contains(QWEATHER_KEY_PLACEHOLDER));
        let replaced = raw.replace(QWEATHER_KEY_PLACEHOLDER, "abc123");
        assert!(!replaced.contains('{'));
        assert!(replaced.contains("key=abc123"));
    }

    /// 回归：白名单站点 302 到非白名单地址时必须被拦截（原先默认跟随）
    #[tokio::test]
    async fn redirect_to_non_whitelisted_host_is_blocked() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        // 本地"目标"服务：若被访问就说明重定向绕过了白名单
        let target = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target_port = target.local_addr().unwrap().port();
        let hit = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let hit2 = hit.clone();
        tokio::spawn(async move {
            if let Ok((mut sock, _)) = target.accept().await {
                hit2.store(true, std::sync::atomic::Ordering::SeqCst);
                let mut buf = [0u8; 512];
                let _ = sock.read(&mut buf).await;
                let _ = sock
                    .write_all(b"HTTP/1.1 200 OK
Content-Length: 2

ok")
                    .await;
            }
        });
        // 跳板服务：返回 302 指向上面的内网目标
        let hop = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let hop_port = hop.local_addr().unwrap().port();
        tokio::spawn(async move {
            if let Ok((mut sock, _)) = hop.accept().await {
                let mut buf = [0u8; 512];
                let _ = sock.read(&mut buf).await;
                let resp = format!(
                    "HTTP/1.1 302 Found
Location: http://127.0.0.1:{target_port}/secret
Content-Length: 0

"
                );
                let _ = sock.write_all(resp.as_bytes()).await;
            }
        });

        let client = build_client(None).unwrap();
        let res = do_get(&client, &format!("http://127.0.0.1:{hop_port}/")).await;
        assert!(res.is_err(), "重定向到非白名单地址应失败，实际: {res:?}");
        assert!(
            !hit.load(std::sync::atomic::Ordering::SeqCst),
            "内网目标不应被访问"
        );
    }
}
