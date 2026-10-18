//! 网盘解析 / 下载插件（`netdisk`）的后端支撑
//!
//! 外部插件跑在主窗口的 WebView 里，受应用 CSP 限制（`connect-src` 只有天气、
//! B 站等少数域名），既不能 `fetch` 网盘接口，也没有任何文件写入 / 下载能力。
//! 所以这里给插件补上两件事：
//!
//! 1. `http`：带 Cookie 罐的通用 HTTP 转发（域名白名单限定在网盘相关域名）
//! 2. `download`：多连接分片下载 + 进度轮询
//!
//! 插件侧只负责各家网盘的协议逻辑（解析分享页、取直链），传输与下载都在 Rust。

pub mod domain;
pub mod download;
pub mod http;
