//! 网盘解析 / 下载（`netdisk`）的后端支撑
//!
//! 这里有两套东西，面向两种用法：
//!
//! 1. **独立软件（推荐）**：`app` 模块负责把 `netdisk-app/` 那个 Python 程序拉起来。
//!    它有自己的界面、自己的进程 —— 下载不再依赖插件面板是否开着，也不受应用
//!    CSP（不能发请求、不能写文件）限制。
//! 2. **应用内下载（可选）**：`http` + `download` 给插件用的传输与下载能力。
//!    外部插件跑在 WebView 里，受 CSP 限制既不能 `fetch` 网盘接口也没有写文件能力，
//!    所以这条路必须由 Rust 代劳。

pub mod app;
pub mod domain;
pub mod download;
pub mod http;
