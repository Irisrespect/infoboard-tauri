//! 网络公共逻辑（代理选择）
//!
//! 规则：**只认用户显式配置的环境变量代理，没有就直连。**
//!
//! 不再硬编码本机 Clash / v2rayN 端口（7897 / 7890 / 10809 / 1080）：
//! - 没跑代理的机器上，每次请求都会多出几次必然失败的连接；
//! - 端口被别的服务占用时，请求（含 API Key）会被转发给未知进程。
//!
//! 想让应用走本机代理，就设置 `HTTPS_PROXY`（或 `HTTP_PROXY` / `ALL_PROXY`）。
//! 若将来要保留"自动用本机代理"的便利，应做成设置项由用户显式填写地址，
//! 而不是写死端口。

/// 从候选值里挑出第一个非空代理地址（纯函数，便于测试）
pub fn pick_proxy<I: IntoIterator<Item = Option<String>>>(candidates: I) -> Option<String> {
    candidates
        .into_iter()
        .flatten()
        .map(|p| p.trim().to_string())
        .find(|p| !p.is_empty())
}

/// 环境变量代理：`HTTPS_PROXY` → `https_proxy` → `HTTP_PROXY` → … → `all_proxy`
pub fn env_proxy() -> Option<String> {
    pick_proxy([
        std::env::var("HTTPS_PROXY").ok(),
        std::env::var("https_proxy").ok(),
        std::env::var("HTTP_PROXY").ok(),
        std::env::var("http_proxy").ok(),
        std::env::var("ALL_PROXY").ok(),
        std::env::var("all_proxy").ok(),
    ])
}

/// 一次请求的尝试顺序（纯函数，便于测试）：
/// - 有环境变量代理 → `[Some(代理), None]`（代理优先，失败后直连兜底）
/// - 没有 → 只有 `[None]`（直连）
pub fn build_attempts(env_proxy: Option<String>) -> Vec<Option<String>> {
    match pick_proxy([env_proxy]) {
        Some(proxy) => vec![Some(proxy), None],
        None => vec![None],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pick_proxy_uses_first_non_empty() {
        let got = pick_proxy([
            None,
            Some("  ".into()),
            Some("http://p:1".into()),
            Some("http://q:2".into()),
        ]);
        assert_eq!(got.as_deref(), Some("http://p:1"));
    }

    #[test]
    fn pick_proxy_none_means_direct() {
        assert_eq!(pick_proxy([None, None, Some("".into())]), None);
        assert_eq!(pick_proxy(Vec::<Option<String>>::new()), None);
    }

    /// 回归（C2/P1-d）：没有环境变量代理时只能直连，不能凭空返回本机 Clash 端口
    #[test]
    fn attempts_without_env_proxy_is_direct_only() {
        let attempts = build_attempts(None);
        assert_eq!(attempts.len(), 1);
        assert_eq!(attempts[0], None);
        // 不能出现任何"本机常见代理端口"
        assert!(!attempts.iter().flatten().any(|p| p.contains("7897")
            || p.contains("7890")
            || p.contains("10809")
            || p.contains("127.0.0.1:1080")));
    }

    #[test]
    fn attempts_with_env_proxy_prefers_proxy_then_direct() {
        let attempts = build_attempts(Some("http://127.0.0.1:9999".into()));
        assert_eq!(attempts.len(), 2);
        assert_eq!(attempts[0].as_deref(), Some("http://127.0.0.1:9999"));
        assert_eq!(attempts[1], None);
    }

    #[test]
    fn attempts_with_blank_env_proxy_is_direct_only() {
        assert_eq!(build_attempts(Some("   ".into())), vec![None]);
    }
}
