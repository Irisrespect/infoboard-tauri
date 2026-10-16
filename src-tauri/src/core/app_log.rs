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
    let ts = chrono_like_now();
    let line = format!("[{ts}] [{level}] [{source}] {message}");
    if let Some(path) = ensure_log_path(app) {
        append_file(&path, &line);
    }
    let _ = app.emit(
        "app_log",
        AppLogPayload {
            level: level.to_string(),
            message: message.to_string(),
            source: source.to_string(),
        },
    );
    // 仍打印到 stdout（dev 可见）
    println!("{line}");
}

fn chrono_like_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // 简单时间戳，避免引入 chrono 依赖
    format!("{secs}")
}

/// 返回日志文件路径
#[tauri::command]
pub fn log_get_path(app: AppHandle) -> Result<String, String> {
    ensure_log_path(&app)
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "无法获取日志路径".into())
}

/// 前端也可写入同一文件（方便统一导出）
#[tauri::command]
pub fn log_append_file(app: AppHandle, level: String, message: String) -> Result<(), String> {
    let path = ensure_log_path(&app).ok_or_else(|| "无法获取日志路径".to_string())?;
    let ts = chrono_like_now();
    append_file(&path, &format!("[{ts}] [{level}] [web] {message}"));
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
}
