//! 网盘后端允许访问的域名白名单
//!
//! 外部插件跑在主窗口里，本身受 WebView CSP 限制（`connect-src` 只列了天气 /
//! B 站等几个域名），因此所有网盘请求都必须绕道 Rust。既然多了一个"万能 HTTP
//! 通道"，就必须把它锁在网盘相关的域名上 —— 否则任何插件都能拿它当匿名代理。
//!
//! 匹配规则（与 `core::http_proxy` 的写法保持一致）：
//! - 模式 `baidu.com` 匹配 `baidu.com` 本身与任意子域 `x.baidu.com`
//! - 模式含 `*` 时按通配符匹配（用于蓝奏云这类天天换域名的服务）

/// 允许请求的域名后缀 / 通配模式
pub const ALLOWED_HOSTS: &[&str] = &[
    // ── 百度网盘 ──
    "baidu.com",
    "baidupcs.com",
    "baidubce.com",
    "bdstatic.com",
    // ── 夸克 / UC 网盘 ──
    "quark.cn",
    "uc.cn",
    "ucweb.com",
    // ── 阿里云盘（alipan.com 新域名 / aliyundrive.com 旧域名）──
    "alipan.com",
    "aliyundrive.com",
    "aliyuncs.com",
    "aliyun.com",
    // ── 123 云盘 ──
    "123pan.com",
    "123684.com",
    "123865.com",
    "123912.com",
    "123pan.cn",
    // ── 蓝奏云（域名池极大且天天换，用通配符兜住；`?` 恰好一个字符）──
    "lanzou?.com",
    "lanzou?.cn",
    "lanzou.com",
    "lanzn.com",
    "lanzt.com",
    "ilanzou.com",
    // ── 迅雷云盘 ──
    "xunlei.com",
    "xunlei.cn",
    "xunlei.net",
    // ── 天翼云盘 ──
    "189.cn",
    "21cn.com",
    // ── 中国移动云盘 / 和彩云 ──
    "139.com",
    "mcloud.com",
    "cmcccloud.com",
    // ── 115 网盘 ──
    "115.com",
    "anxia.com",
    "115cdn.com",
    "115cdn.net",
    // ── 城通网盘 ──
    "ctfile.com",
    "ctfile.net",
    "545c.com",
];

/// 通配符匹配（对整串）：`*` 匹配任意（含空）字符序列，`?` 恰好匹配一个字符
fn glob_match(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    // 经典双指针 + 回溯
    let (mut pi, mut ti) = (0usize, 0usize);
    let (mut star, mut mark) = (None::<usize>, 0usize);
    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = ti;
            pi += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

/// 通配模式按"域后缀"匹配：`lanzou?.com` 既能匹配 `lanzoux.com`，
/// 也能匹配 `www.lanzoui.com`，但**不会**匹配 `lanzoux.attacker.com`
/// （只在标签边界上取后缀，因此 `?` 必须落在主体域里）
fn suffix_glob_match(pattern: &str, host: &str) -> bool {
    for (i, _) in host.char_indices() {
        if i == 0 || host.as_bytes()[i - 1] == b'.' {
            if glob_match(pattern, &host[i..]) {
                return true;
            }
        }
    }
    false
}

/// 域名是否允许（大小写不敏感）
pub fn host_allowed(host: &str) -> bool {
    let h = host.trim().to_ascii_lowercase();
    if h.is_empty() {
        return false;
    }
    ALLOWED_HOSTS.iter().any(|pat| {
        if pat.contains('*') || pat.contains('?') {
            suffix_glob_match(pat, &h)
        } else {
            h == *pat || h.ends_with(&format!(".{pat}"))
        }
    })
}

/// 单次请求的最终校验：scheme + host 白名单
pub fn url_allowed(url: &str, allow_http: bool) -> Result<url::Url, String> {
    let parsed = url::Url::parse(url).map_err(|e| format!("URL 无效: {e}"))?;
    match parsed.scheme() {
        "https" => {}
        "http" if allow_http => {}
        other => {
            return Err(format!(
                "不支持的协议: {other}（仅允许 https{}）",
                if allow_http { " / http" } else { "" }
            ))
        }
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "URL 缺少 host".to_string())?
        .to_string();
    if !host_allowed(&host) {
        return Err(format!("域名不在网盘白名单内: {host}"));
    }
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 允许各网盘主域与子域() {
        assert!(host_allowed("pan.baidu.com"));
        assert!(host_allowed("baidu.com"));
        assert!(host_allowed("d.pcs.baidu.com"));
        assert!(host_allowed("pan.quark.cn"));
        assert!(host_allowed("www.alipan.com"));
        assert!(host_allowed("api.alipan.com"));
        assert!(host_allowed("www.123pan.com"));
        assert!(host_allowed("cloud.189.cn"));
        assert!(host_allowed("webapi.115.com"));
    }

    #[test]
    fn 拒绝无关域名与伪造后缀() {
        assert!(!host_allowed("evil.com"));
        assert!(!host_allowed(""));
        // 关键回归：后缀匹配不能被骗过
        assert!(!host_allowed("baidu.com.evil.com"));
        assert!(!host_allowed("notbaidu.com"));
        assert!(!host_allowed("quark.cn.attacker.net"));
    }

    #[test]
    fn 蓝奏云通配匹配() {
        assert!(host_allowed("www.lanzoui.com"));
        assert!(host_allowed("wws.lanzouq.com"));
        assert!(host_allowed("lanzoux.com"));
        assert!(host_allowed("pan.lanzou.com"));
        assert!(host_allowed("lanzn.com"));
        assert!(host_allowed("www.ilanzou.com"));
        // 关键回归：通配符不能把 lanzou 当"前缀"放行任意域名
        assert!(!host_allowed("lanzou.evil.com"));
        assert!(!host_allowed("lanzoux.attacker.com"));
        assert!(!host_allowed("lanzouab.com"));
    }

    #[test]
    fn url_校验协议与域名() {
        assert!(url_allowed("https://pan.baidu.com/s/1abc", false).is_ok());
        assert!(url_allowed("http://pan.baidu.com/s/1abc", false).is_err());
        assert!(url_allowed("http://pan.baidu.com/s/1abc", true).is_ok());
        assert!(url_allowed("https://evil.com/x", true).is_err());
        assert!(url_allowed("file:///C:/x", true).is_err());
    }
}
