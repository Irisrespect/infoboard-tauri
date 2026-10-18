//! 网盘 HTTP 转发：给插件用的通用请求通道
//!
//! 为什么需要它：外部插件跑在 WebView 里，`fetch` 受应用 CSP（`connect-src`
//! 只列了天气 / B 站等几个域名）限制，且网盘接口普遍需要自定义请求头、Cookie
//! 与 POST，浏览器侧还会撞 CORS。所以请求统一走 Rust 发出。
//!
//! 安全约束：
//! - 域名白名单（见 `super::domain`），并且**重定向的每一跳都重新校验**
//! - 只允许 https（少数站点显式传 `allowHttp` 才放行 http）
//! - Cookie 罐按 session 隔离，且按"可注册域"分桶，避免同 session 下
//!   A 站点的 Cookie 被发到 B 站点

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::AppHandle;

use super::domain::{host_allowed, url_allowed};

/// 默认 UA：网盘接口多数要求"像浏览器"，插件可以覆盖
pub const DEFAULT_UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

fn default_true() -> bool {
    true
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NetdiskHttpRequest {
    pub url: String,
    /// 默认 GET
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub headers: Option<HashMap<String, String>>,
    #[serde(default)]
    pub body: Option<String>,
    /// Cookie 罐标识：同一 session 共享 Cookie（如 "baidu"、"quark"）
    #[serde(default)]
    pub session: Option<String>,
    /// 是否自动带上 / 存下 Cookie（默认 true）
    #[serde(default = "default_true")]
    pub use_cookies: bool,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    /// 允许明文 http（蓝奏云等少数站点需要）
    #[serde(default)]
    pub allow_http: bool,
    /// 是否跟随重定向（默认 true；登录跳转链路有时需要关掉自己处理）
    #[serde(default = "default_true")]
    pub follow_redirects: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetdiskHttpResponse {
    pub status: u16,
    pub final_url: String,
    /// 响应头（键统一小写；同名头用 `,` 合并）
    pub headers: HashMap<String, String>,
    pub body: String,
    /// 本次响应里的 Set-Cookie（便于插件调试登录态）
    pub set_cookies: Vec<String>,
}

// ─── Cookie 罐 ───

/// session → (可注册域 → (cookie 名 → 值))
type Jar = HashMap<String, HashMap<String, HashMap<String, String>>>;

fn jars() -> &'static Mutex<Jar> {
    static JARS: OnceLock<Mutex<Jar>> = OnceLock::new();
    JARS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 取"可注册域"近似值：`d.pcs.baidu.com` → `baidu.com`
///
/// 不做 PSL 解析（没必要引 publicsuffix 依赖）：网盘域名都是
/// `xxx.<主体>.<顶级>` 结构，取最后两段足够，且不会把 Cookie 发错站点。
pub(super) fn cookie_domain(host: &str) -> String {
    let h = host.trim().to_ascii_lowercase();
    let parts: Vec<&str> = h.split('.').filter(|s| !s.is_empty()).collect();
    if parts.len() <= 2 {
        return h;
    }
    // 处理 com.cn / com.hk 这类两段式顶级域，避免把 "com.cn" 当主体
    let last2 = format!("{}.{}", parts[parts.len() - 2], parts[parts.len() - 1]);
    if matches!(
        last2.as_str(),
        "com.cn" | "net.cn" | "org.cn" | "gov.cn" | "com.hk" | "com.tw"
    ) && parts.len() >= 3
    {
        return format!("{}.{}", parts[parts.len() - 3], last2);
    }
    last2
}

/// 解析一条 Set-Cookie，返回 (名, 值)；`None` 表示格式无效
fn parse_set_cookie(line: &str) -> Option<(String, String, bool)> {
    let mut parts = line.split(';');
    let first = parts.next()?.trim();
    let (name, value) = first.split_once('=')?;
    let name = name.trim().to_string();
    if name.is_empty() {
        return None;
    }
    let value = value.trim().to_string();
    // 过期判定：Max-Age=0 或 Expires 是 1970 年（删除 Cookie）
    let mut expired = value.is_empty();
    for attr in parts {
        let a = attr.trim().to_ascii_lowercase();
        if a == "max-age=0" || a.starts_with("max-age=-") {
            expired = true;
        }
        if let Some(rest) = a.strip_prefix("expires=") {
            if rest.contains("1970") || rest.contains("1969") {
                expired = true;
            }
        }
    }
    Some((name, value, expired))
}

/// 把响应里的 Set-Cookie 存进罐子
pub(super) fn store_cookies(session: Option<&str>, host: &str, set_cookies: &[String]) {
    let Some(session) = session.filter(|s| !s.trim().is_empty()) else {
        return;
    };
    let key = cookie_domain(host);
    let Ok(mut guard) = jars().lock() else { return };
    let bucket = guard
        .entry(session.to_string())
        .or_default()
        .entry(key)
        .or_default();
    for line in set_cookies {
        if let Some((name, value, expired)) = parse_set_cookie(line) {
            if expired {
                bucket.remove(&name);
            } else {
                bucket.insert(name, value);
            }
        }
    }
}

/// Cookie 头的长度上限。
///
/// 实测（夸克，2026-10）：把浏览器**全部** Cookie（约 7.2KB，含大量无关域）
/// 一次性发过去，服务端会直接掐断连接（表现为 IncompleteRead / ChunkedEncodingError）；
/// 只发该网盘域下的 25 项就一切正常。所以这里主动卡一道，
/// 把"连接被莫名掐断"变成一个能看懂、能照做的报错。
const MAX_COOKIE_HEADER_BYTES: usize = 6144;

/// 校验 Cookie 头没有大到"一发就被掐"
pub(super) fn check_cookie_size(header: &str) -> Result<(), String> {
    if header.len() > MAX_COOKIE_HEADER_BYTES {
        return Err(format!(
            "登录信息过大（{} KB，上限 {} KB）：多半是把浏览器里所有 Cookie 都粘进来了。\
             请只复制该网盘域名下的 Cookie（开发者工具里按 pan.quark.cn 之类筛选），\
             否则服务端会直接掐断连接。",
            header.len() / 1024,
            MAX_COOKIE_HEADER_BYTES / 1024
        ));
    }
    Ok(())
}

/// 取出该 host 能用的 Cookie 头
pub(super) fn cookie_header(session: Option<&str>, host: &str) -> Option<String> {
    let session = session.filter(|s| !s.trim().is_empty())?;
    let host = host.trim().to_ascii_lowercase();
    let guard = jars().lock().ok()?;
    let per_domain = guard.get(session)?;
    let mut out: Vec<String> = Vec::new();
    for (domain, cookies) in per_domain.iter() {
        // 只发属于该域及其子域的 Cookie
        if host == *domain || host.ends_with(&format!(".{domain}")) {
            for (k, v) in cookies.iter() {
                out.push(format!("{k}={v}"));
            }
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out.join("; "))
    }
}

/// 合并手工导入的 Cookie 串（"BDUSS=xxx; STOKEN=yyy"）
pub(super) fn import_cookies(session: &str, host: &str, raw: &str) -> usize {
    let key = cookie_domain(host);
    let mut count = 0usize;
    let Ok(mut guard) = jars().lock() else {
        return 0;
    };
    let bucket = guard
        .entry(session.to_string())
        .or_default()
        .entry(key)
        .or_default();
    for piece in raw.split(';') {
        let p = piece.trim();
        if p.is_empty() {
            continue;
        }
        if let Some((k, v)) = p.split_once('=') {
            let k = k.trim().to_string();
            let v = v.trim().trim_matches('"').to_string();
            if !k.is_empty() && !v.is_empty() {
                bucket.insert(k, v);
                count += 1;
            }
        }
    }
    count
}

// ─── 命令 ───

#[tauri::command]
pub async fn netdisk_http_request(
    app: AppHandle,
    req: NetdiskHttpRequest,
) -> Result<NetdiskHttpResponse, String> {
    let parsed = url_allowed(&req.url, req.allow_http)?;
    let host = parsed.host_str().unwrap_or_default().to_string();

    let method = req
        .method
        .as_deref()
        .unwrap_or("GET")
        .trim()
        .to_ascii_uppercase();
    if !matches!(
        method.as_str(),
        "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD"
    ) {
        return Err(format!("不支持的请求方法: {method}"));
    }

    let timeout = Duration::from_millis(req.timeout_ms.unwrap_or(20_000).clamp(1_000, 120_000));
    let mut builder = reqwest::Client::builder()
        .timeout(timeout)
        .connect_timeout(Duration::from_secs(10))
        .user_agent(DEFAULT_UA);

    builder = if req.follow_redirects {
        builder.redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 {
                return attempt.error("重定向次数过多");
            }
            let ok = attempt.url().host_str().map(host_allowed).unwrap_or(false);
            if ok {
                attempt.follow()
            } else {
                attempt.error("重定向目标不在白名单")
            }
        }))
    } else {
        builder.redirect(reqwest::redirect::Policy::none())
    };

    let client = builder
        .build()
        .map_err(|e| format!("HTTP 客户端创建失败: {e}"))?;

    let mut rb = client.request(
        reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| format!("方法无效: {e}"))?,
        parsed.clone(),
    );

    // 先放 Cookie（插件显式传的 Cookie 头优先级更高，后面覆盖）
    if req.use_cookies {
        if let Some(c) = cookie_header(req.session.as_deref(), &host) {
            check_cookie_size(&c)?;
            rb = rb.header(reqwest::header::COOKIE, c);
        }
    }
    if let Some(headers) = &req.headers {
        for (k, v) in headers {
            // 过滤掉 reqwest 不接受的非法头名，避免一个坏头让整个请求失败
            if let (Ok(name), Ok(val)) = (
                reqwest::header::HeaderName::from_bytes(k.as_bytes()),
                reqwest::header::HeaderValue::from_str(v),
            ) {
                rb = rb.header(name, val);
            }
        }
    }
    if let Some(body) = req.body.clone() {
        rb = rb.body(body);
    }

    let resp = rb
        .send()
        .await
        // reqwest 的错误文本默认带完整 URL（查询串里可能有签名/凭据），必须去掉
        .map_err(|e| format!("网络错误: {}", e.without_url()))?;

    let status = resp.status();
    let final_url = resp.url().to_string();
    let final_host = resp.url().host_str().unwrap_or_default().to_string();

    let mut headers: HashMap<String, String> = HashMap::new();
    let mut set_cookies: Vec<String> = Vec::new();
    for (k, v) in resp.headers().iter() {
        let key = k.as_str().to_ascii_lowercase();
        if key == "set-cookie" {
            if let Ok(s) = v.to_str() {
                set_cookies.push(s.to_string());
            }
            continue;
        }
        if let Ok(s) = v.to_str() {
            headers
                .entry(key)
                .and_modify(|old| {
                    old.push_str(", ");
                    old.push_str(s);
                })
                .or_insert_with(|| s.to_string());
        }
    }

    if req.use_cookies && !set_cookies.is_empty() {
        store_cookies(req.session.as_deref(), &final_host, &set_cookies);
    }

    let body = resp
        .text()
        .await
        .map_err(|e| format!("读取响应失败: {}", e.without_url()))?;

    crate::core::app_log::emit(
        &app,
        if status.is_success() { "debug" } else { "warn" },
        &format!(
            "[netdisk] {} {host} → {} ({} 字节)",
            method,
            status.as_u16(),
            body.len()
        ),
    );

    Ok(NetdiskHttpResponse {
        status: status.as_u16(),
        final_url,
        headers,
        body,
        set_cookies,
    })
}

/// 手工导入 Cookie（用户从浏览器复制）
#[tauri::command]
pub fn netdisk_cookie_import(session: String, host: String, raw: String) -> Result<usize, String> {
    if !host_allowed(&host) {
        return Err(format!("域名不在网盘白名单内: {host}"));
    }
    Ok(import_cookies(&session, &host, &raw))
}

/// 查看某个 session 已存下的 Cookie 名（只返回名字，不回传值）
#[tauri::command]
pub fn netdisk_cookie_list(session: String) -> Vec<String> {
    let Ok(guard) = jars().lock() else {
        return Vec::new();
    };
    let Some(per_domain) = guard.get(&session) else {
        return Vec::new();
    };
    let mut out: Vec<String> = Vec::new();
    for (domain, cookies) in per_domain.iter() {
        for name in cookies.keys() {
            out.push(format!("{domain}:{name}"));
        }
    }
    out.sort();
    out
}

/// 清空某个 session 的 Cookie
#[tauri::command]
pub fn netdisk_cookie_clear(session: String) -> usize {
    let Ok(mut guard) = jars().lock() else {
        return 0;
    };
    guard.remove(&session).map(|m| m.len()).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cookie_域取主体域() {
        assert_eq!(cookie_domain("d.pcs.baidu.com"), "baidu.com");
        assert_eq!(cookie_domain("pan.baidu.com"), "baidu.com");
        assert_eq!(cookie_domain("baidu.com"), "baidu.com");
        assert_eq!(cookie_domain("pan.quark.cn"), "quark.cn");
        // 两段式顶级域不能把 com.cn 当主体
        assert_eq!(cookie_domain("cloud.189.cn"), "189.cn");
    }

    #[test]
    fn 解析_set_cookie() {
        assert_eq!(
            parse_set_cookie("BDUSS=abc123; Path=/; Domain=.baidu.com; HttpOnly"),
            Some(("BDUSS".into(), "abc123".into(), false))
        );
        assert_eq!(
            parse_set_cookie("STOKEN=; Path=/"),
            Some(("STOKEN".into(), "".into(), true))
        );
        assert_eq!(
            parse_set_cookie("X=1; Max-Age=0"),
            Some(("X".into(), "1".into(), true))
        );
        assert!(parse_set_cookie("novalue").is_none());
    }

    #[test]
    fn cookie_按域隔离且只发给子域() {
        let session = "test-session-隔离";
        import_cookies(session, "pan.baidu.com", "BDUSS=aaa; STOKEN=bbb");
        import_cookies(session, "pan.quark.cn", "__puus=ccc");

        let baidu = cookie_header(Some(session), "d.pcs.baidu.com").unwrap();
        assert!(baidu.contains("BDUSS=aaa"));
        assert!(baidu.contains("STOKEN=bbb"));
        // 夸克的 Cookie 不能跟着发到百度
        assert!(!baidu.contains("__puus"));

        let quark = cookie_header(Some(session), "pan.quark.cn").unwrap();
        assert!(quark.contains("__puus=ccc"));
        assert!(!quark.contains("BDUSS"));

        // 无关域名拿不到任何 Cookie
        assert!(cookie_header(Some(session), "www.alipan.com").is_none());

        guard_clear(session);
    }

    #[test]
    fn 无_session_时不落盘() {
        store_cookies(None, "pan.baidu.com", &["A=1; Path=/".to_string()]);
        assert!(cookie_header(None, "pan.baidu.com").is_none());
    }

    /// 实测：把浏览器全部 Cookie（~7.2KB）发过去会被服务端直接掐断连接
    #[test]
    fn 过大的登录信息要提前报错而不是等连接被掐() {
        let small = "a".repeat(1024);
        assert!(check_cookie_size(&small).is_ok());

        let huge = format!("__puus={}", "x".repeat(8000));
        let err = check_cookie_size(&huge).unwrap_err();
        assert!(err.contains("过大"), "要说清是登录信息太大: {err}");
        assert!(err.contains("只复制该网盘域名"), "要告诉用户怎么做: {err}");
    }

    /// 只发同域 Cookie：这正是"别把浏览器全部 Cookie 发过去"的实现层保障
    #[test]
    fn 只为目标域拼装_cookie() {
        let session = "size-guard";
        import_cookies(session, "pan.quark.cn", "__puus=ok");
        import_cookies(
            session,
            "pan.baidu.com",
            &format!("BDUSS={}", "b".repeat(8000)),
        );
        // 向夸克请求时，只应带上夸克那一项，不会因为百度那边很大就超限
        let header = cookie_header(Some(session), "drive-pc.quark.cn").unwrap();
        assert!(header.contains("__puus=ok"));
        assert!(!header.contains("BDUSS"));
        assert!(check_cookie_size(&header).is_ok());

        guard_clear(session);
    }

    fn guard_clear(session: &str) {
        if let Ok(mut g) = jars().lock() {
            g.remove(session);
        }
    }
}
