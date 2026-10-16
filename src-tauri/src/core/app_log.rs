//! 后端日志 → 前端日志台 + 本地文件
//!
//! 打包后无 DevTools 时，通过 emit("app_log") 推到应用内日志台，
//! 并追加写入 %APPDATA%/infoboard-tauri/app.log。

use serde::Serialize;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppLogPayload {
    pub level: String,
    pub message: String,
    pub source: String,
}

static LOG_PATH: Mutex<Option<PathBuf>> = Mutex::new(None);

fn ensure_log_path(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(guard) = LOG_PATH.lock() {
        if let Some(p) = guard.as_ref() {
            return Some(p.clone());
        }
    }
    let dir = app.path().app_data_dir().ok()?;
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("app.log");
    if let Ok(mut guard) = LOG_PATH.lock() {
        *guard = Some(path.clone());
    }
    Some(path)
}

/// 单个日志文件上限；超出后轮转为 `app.log.1`（只保留一份旧档）
const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;

/// 单条日志消息上限；超出截断，避免一次写入巨大内容
const MAX_MESSAGE_BYTES: usize = 8 * 1024;

/// 允许的日志级别（来自前端 `log_append_file`），其余一律归一为 info
const ALLOWED_LEVELS: &[&str] = &["error", "warn", "info", "debug", "log"];

/// 归一化日志级别：白名单之外（含空串、未知级别、大小写混杂）都当 info。
/// 不校验的话前端可以塞任意文本进日志行的 `[level]` 位置。
pub fn normalize_level(level: &str) -> &'static str {
    let lowered = level.trim().to_ascii_lowercase();
    if lowered == "warning" {
        return "warn";
    }
    ALLOWED_LEVELS
        .iter()
        .find(|l| **l == lowered)
        .copied()
        .unwrap_or("info")
}

/// 清理日志消息：`\r` / `\n` 换成空格（否则一条日志能伪造成多行），并限制长度
pub fn sanitize_message(message: &str) -> String {
    let one_line: String = message
        .chars()
        .map(|c| if c == '\n' || c == '\r' { ' ' } else { c })
        .collect();
    crate::core::text::truncate_bytes(one_line.trim(), MAX_MESSAGE_BYTES).to_string()
}

/// 可读的本地时间戳（写文件用；此前是裸 Unix 秒，人看不懂）
fn now_timestamp() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

fn rotate_if_needed(path: &PathBuf, max_bytes: u64) {
    let too_big = std::fs::metadata(path)
        .map(|m| m.len() >= max_bytes)
        .unwrap_or(false);
    if !too_big {
        return;
    }
    let mut backup = path.as_os_str().to_owned();
    backup.push(".1");
    let backup = PathBuf::from(backup);
    let _ = std::fs::remove_file(&backup);
    let _ = std::fs::rename(path, &backup);
}

fn append_file(path: &PathBuf, line: &str) {
    rotate_if_needed(path, MAX_LOG_BYTES);
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{line}");
    }
}

/// 发往前端日志台，并写本地文件
pub fn emit(app: &AppHandle, level: &str, message: &str) {
    let source = "rust";
    // 同样过一遍归一化/清理，保证写进文件的每条日志都恰好一行
    let level = normalize_level(level);
    let message = sanitize_message(message);
    let line = format!("[{}] [{level}] [{source}] {message}", now_timestamp());
    if let Some(path) = ensure_log_path(app) {
        append_file(&path, &line);
    }
    let _ = app.emit(
        "app_log",
        AppLogPayload {
            level: level.to_string(),
            message: message.clone(),
            source: source.to_string(),
        },
    );
    // 仍打印到 stdout（dev 可见）
    println!("{line}");
}

/// 返回日志文件路径
#[tauri::command]
pub fn log_get_path(app: AppHandle) -> Result<String, String> {
    ensure_log_path(&app)
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "无法获取日志路径".into())
}

/// 前端也可写入同一文件（方便统一导出）。
/// 只写 web 侧的 warn / error —— Rust 侧 `emit` 已经自己落盘，
/// 前端再写一次会出现 `[web] [web]` 重复行。
#[tauri::command]
pub fn log_append_file(app: AppHandle, level: String, message: String) -> Result<(), String> {
    let path = ensure_log_path(&app).ok_or_else(|| "无法获取日志路径".to_string())?;
    let level = normalize_level(&level);
    let message = sanitize_message(&message);
    append_file(&path, &format!("[{}] [{level}] [web] {message}", now_timestamp()));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_log(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("infoboard-log-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("app.log")
    }

    /// 回归：日志不能无限增长
    #[test]
    fn log_is_rotated_when_over_limit() {
        let path = temp_log("rotate");
        std::fs::write(&path, vec![b'x'; 200]).unwrap();
        rotate_if_needed(&path, 100);
        append_file(&path, "new line");
        let cur = std::fs::read_to_string(&path).unwrap();
        assert_eq!(cur.trim(), "new line");
        let mut backup = path.as_os_str().to_owned();
        backup.push(".1");
        assert_eq!(std::fs::metadata(PathBuf::from(backup)).unwrap().len(), 200);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// append_file 必须真的走轮转：写入超过 MAX_LOG_BYTES 的文件后应产生备份
    #[test]
    fn append_file_triggers_rotation() {
        let path = temp_log("wired");
        let f = std::fs::File::create(&path).unwrap();
        f.set_len(MAX_LOG_BYTES).unwrap();
        drop(f);
        append_file(&path, "fresh");
        let mut backup = path.as_os_str().to_owned();
        backup.push(".1");
        assert!(PathBuf::from(backup).exists(), "超限后应生成 app.log.1");
        assert_eq!(std::fs::read_to_string(&path).unwrap().trim(), "fresh");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn small_log_is_not_rotated() {
        let path = temp_log("small");
        std::fs::write(&path, "old
").unwrap();
        append_file(&path, "more");
        let cur = std::fs::read_to_string(&path).unwrap();
        assert!(cur.contains("old") && cur.contains("more"));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn rotate_replaces_existing_backup() {
        let path = temp_log("replace");
        let mut backup = path.as_os_str().to_owned();
        backup.push(".1");
        let backup = PathBuf::from(backup);
        std::fs::write(&backup, "ancient").unwrap();
        std::fs::write(&path, vec![b'y'; 50]).unwrap();
        rotate_if_needed(&path, 10);
        assert_eq!(std::fs::metadata(&backup).unwrap().len(), 50);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    // ─── log_append_file 的输入校验（前端可传任意字符串） ───

    #[test]
    fn level_outside_whitelist_falls_back_to_info() {
        assert_eq!(normalize_level("error"), "error");
        assert_eq!(normalize_level("WARN"), "warn");
        assert_eq!(normalize_level(" warning "), "warn");
        assert_eq!(normalize_level("debug"), "debug");
        assert_eq!(normalize_level("log"), "log");
        // 非法 / 未知 / 空
        assert_eq!(normalize_level("fatal"), "info");
        assert_eq!(normalize_level(""), "info");
        assert_eq!(normalize_level("info] [web] 伪造行"), "info");
    }

    #[test]
    fn message_newlines_become_spaces() {
        assert_eq!(sanitize_message("a\nb"), "a b");
        assert_eq!(sanitize_message("a\r\nb"), "a  b");
        assert_eq!(sanitize_message("  padded  "), "padded");
    }

    /// 回归：带换行的 message 写进文件后只能产生一行
    #[test]
    fn forged_multiline_message_writes_single_line() {
        let path = temp_log("forged");
        let level = normalize_level("warn");
        let message = sanitize_message("第一行\n[2020-01-01 00:00:00] [error] [rust] 伪造");
        append_file(&path, &format!("[{}] [{level}] [web] {message}", now_timestamp()));
        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(content.lines().count(), 1, "只应有一行: {content:?}");
        // 只有 writeln! 补的那个结尾换行，消息里的换行已被替换
        assert_eq!(content.matches('\n').count(), 1, "不应出现多余换行: {content:?}");
        assert!(content.contains("[web] 第一行 [2020-01-01 00:00:00] [error] [rust] 伪造"));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn oversized_message_is_truncated_on_char_boundary() {
        let long = "汉".repeat(5000); // 15000 字节
        let out = sanitize_message(&long);
        assert!(out.len() <= MAX_MESSAGE_BYTES);
        assert!(out.len() > MAX_MESSAGE_BYTES - 3);
        // 截断后仍是合法 UTF-8（能正常当 &str 用就不会 panic）
        assert!(out.chars().all(|c| c == '汉'));
    }

    #[test]
    fn timestamp_is_human_readable() {
        let ts = now_timestamp();
        // 形如 2026-10-16 20:31:05
        assert_eq!(ts.len(), 19, "时间戳格式不对: {ts}");
        assert_eq!(ts.as_bytes()[4], b'-');
        assert_eq!(ts.as_bytes()[10], b' ');
        assert_eq!(ts.as_bytes()[13], b':');
    }
}
