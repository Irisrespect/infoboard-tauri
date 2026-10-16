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
    let host = parsed.host_str().ok_or_else(|| "缺少 host".to_string())?;
    if !host_allowed(host) {
        let msg = format!("[http_proxy] 拒绝非白名单域名: {host}");
        crate::core::app_log::emit(&app, "warn", &msg);
        return Err(format!("域名不在白名单: {host}"));
    }

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
