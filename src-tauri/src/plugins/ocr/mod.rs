//! OCR 文字识别 — Tauri 后端
//!
//! 对齐 Electron ocr.ts：
//! - 长驻 RapidOCR-json 子进程 + 串行请求队列
//! - 等待 init completed
//! - 响应 recv_timeout 真超时（避免 read_line 永久阻塞）
//! - Drop 时 kill 子进程

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;

const OCR_TIMEOUT: Duration = Duration::from_secs(20);
const INIT_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OcrResponse {
    pub code: i32,
    pub data: Value,
}

struct PendingRequest {
    image_base64: String,
    tx: Sender<Result<OcrResponse, String>>,
}

struct EngineState {
    process: Option<Child>,
    ready: bool,
}

/// 可跨线程共享的引擎句柄（manage 到 Tauri State）
pub struct OcrEngine {
    engine_path: PathBuf,
    state: Arc<Mutex<EngineState>>,
    req_tx: Mutex<Option<Sender<PendingRequest>>>,
    /// 串行化 ensure_started：否则"检查未启动 → 启动"之间并发请求会重复拉起引擎，
    /// 并且互相 shutdown 对方刚启动的进程
    start_lock: Mutex<()>,
}

impl OcrEngine {
    pub fn new() -> Self {
        Self {
            engine_path: get_engine_path(),
            state: Arc::new(Mutex::new(EngineState {
                process: None,
                ready: false,
            })),
            req_tx: Mutex::new(None),
            start_lock: Mutex::new(()),
        }
    }

    /// 指定引擎路径构造（测试用：配合假引擎验证启动并发行为）
    #[cfg(test)]
    fn with_engine_path(engine_path: PathBuf) -> Self {
        Self {
            engine_path,
            state: Arc::new(Mutex::new(EngineState {
                process: None,
                ready: false,
            })),
            req_tx: Mutex::new(None),
            start_lock: Mutex::new(()),
        }
    }

    pub fn path(&self) -> &PathBuf {
        &self.engine_path
    }

    pub fn is_engine_ready(&self) -> bool {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).ready
    }

    fn shutdown_locked(state: &mut EngineState, req_tx: &mut Option<Sender<PendingRequest>>) {
        *req_tx = None;
        state.ready = false;
        if let Some(mut p) = state.process.take() {
            let _ = p.kill();
            let _ = p.wait();
        }
    }

    pub fn shutdown(&self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let mut req_tx = self.req_tx.lock().unwrap_or_else(|e| e.into_inner());
        Self::shutdown_locked(&mut state, &mut req_tx);
    }

    /// 启动进程与读写线程，并阻塞等待 init completed（有截止时间）
    fn ensure_started(&self) -> Result<(), String> {
        // 同一时刻只允许一个线程负责启动；其余线程在此排队，
        // 拿到锁后重新检查状态（已被前一个线程启动好就直接返回）
        let _start_guard = self.start_lock.lock().unwrap_or_else(|e| e.into_inner());
        {
            let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            let has_tx = self.req_tx.lock().unwrap_or_else(|e| e.into_inner()).is_some();
            if state.process.is_some() && state.ready && has_tx {
                return Ok(());
            }
            // 进程在但未 ready / 通道丢了 → 重建
            if state.process.is_some() && (!state.ready || !has_tx) {
                drop(state);
                self.shutdown();
            }
        }

        if !self.engine_path.exists() {
            return Err(format!(
                "OCR 引擎未找到: {}。请将 RapidOCR-json.exe 及 models 放到 src-tauri/binaries/rapidocr/",
                self.engine_path.display()
            ));
        }

        let engine_dir = self
            .engine_path
            .parent()
            .ok_or_else(|| "引擎路径无效".to_string())?;

        let mut cmd = Command::new(&self.engine_path);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            unsafe { cmd.creation_flags(CREATE_NO_WINDOW); }
        }
        let mut child = cmd
            .current_dir(engine_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("启动 OCR 引擎失败: {}", e))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "无法获取子进程 stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "无法获取子进程 stdout".to_string())?;

        let (req_tx, req_rx) = mpsc::channel::<PendingRequest>();
        let (line_tx, line_rx) = mpsc::channel::<Result<String, String>>();

        // 读线程
        let state_r = Arc::clone(&self.state);
        thread::Builder::new()
            .name("ocr-stdout".into())
            .spawn(move || {
                let mut reader = BufReader::new(stdout);
                let mut buf = String::new();
                loop {
                    buf.clear();
                    match reader.read_line(&mut buf) {
                        Ok(0) => {
                            let _ = line_tx.send(Err("OCR 进程 stdout 已关闭".into()));
                            break;
                        }
                        Ok(_) => {
                            let trimmed = buf.trim();
                            if trimmed.is_empty() {
                                continue;
                            }
                            if trimmed.contains("init completed") {
                                if let Ok(mut st) = state_r.lock() {
                                    st.ready = true;
                                }
                                log::info!("[OCR] 引擎初始化完成");
                                continue;
                            }
                            if line_tx.send(Ok(trimmed.to_string())).is_err() {
                                break;
                            }
                        }
                        Err(e) => {
                            let _ = line_tx.send(Err(format!("读取 OCR stdout 失败: {}", e)));
                            break;
                        }
                    }
                }
                if let Ok(mut st) = state_r.lock() {
                    st.ready = false;
                    if let Some(mut p) = st.process.take() {
                        let _ = p.kill();
                        let _ = p.wait();
                    }
                }
            })
            .map_err(|e| format!("启动 OCR 读线程失败: {}", e))?;

        // 写/调度线程
        let state_w = Arc::clone(&self.state);
        thread::Builder::new()
            .name("ocr-worker".into())
            .spawn(move || worker_loop(stdin, req_rx, line_rx, state_w))
            .map_err(|e| format!("启动 OCR 写线程失败: {}", e))?;

        {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            state.process = Some(child);
            state.ready = false;
        }
        *self.req_tx.lock().unwrap_or_else(|e| e.into_inner()) = Some(req_tx);

        // 等 init（轮询 ready，不阻塞在 read_line）
        let deadline = Instant::now() + INIT_TIMEOUT;
        while Instant::now() < deadline {
            {
                let st = self.state.lock().unwrap_or_else(|e| e.into_inner());
                if st.ready {
                    return Ok(());
                }
                if st.process.is_none() {
                    return Err("OCR 进程启动后意外退出".into());
                }
            }
            thread::sleep(Duration::from_millis(40));
        }
        self.shutdown();
        Err("OCR 引擎初始化超时（30s），请检查 models 目录是否完整".into())
    }

    /// 识别一次（真超时）
    pub fn recognize(&self, image_base64: String) -> Result<OcrResponse, String> {
        self.ensure_started()?;

        let req_tx = self
            .req_tx
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .ok_or_else(|| "OCR 请求通道未就绪".to_string())?;

        let (tx, rx) = mpsc::channel();
        if req_tx
            .send(PendingRequest {
                image_base64,
                tx,
            })
            .is_err()
        {
            self.shutdown();
            return Err("OCR 请求通道已关闭，引擎可能已崩溃".into());
        }

        match rx.recv_timeout(OCR_TIMEOUT) {
            Ok(r) => r,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                self.shutdown();
                Err("OCR 识别超时（20s）".into())
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                self.shutdown();
                Err("OCR 响应通道断开".into())
            }
        }
    }
}

impl Drop for OcrEngine {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn worker_loop(
    mut stdin: ChildStdin,
    req_rx: Receiver<PendingRequest>,
    line_rx: Receiver<Result<String, String>>,
    state: Arc<Mutex<EngineState>>,
) {
    for req in req_rx {
        // 确保 ready
        if !state.lock().map(|s| s.ready).unwrap_or(false) {
            let _ = req
                .tx
                .send(Err("OCR 引擎未就绪".into()));
            continue;
        }

        let payload = serde_json::json!({ "image_base64": req.image_base64 }).to_string();
        if let Err(e) = writeln!(stdin, "{}", payload).and_then(|_| stdin.flush()) {
            let _ = req.tx.send(Err(format!("写入 stdin 失败: {}", e)));
            if let Ok(mut st) = state.lock() {
                st.ready = false;
            }
            break;
        }

        let deadline = Instant::now() + OCR_TIMEOUT;
        let mut answered = false;
        while Instant::now() < deadline {
            let remain = deadline.saturating_duration_since(Instant::now());
            match line_rx.recv_timeout(remain) {
                Ok(Ok(line)) => {
                    if line.contains("init completed") || line.is_empty() {
                        continue;
                    }
                    if !line.starts_with('{') {
                        log::info!("[OCR] 非 JSON: {}", crate::core::text::truncate_bytes(&line, 200));
                        continue;
                    }
                    match serde_json::from_str::<OcrResponse>(&line) {
                        Ok(resp) => {
                            let _ = req.tx.send(Ok(resp));
                            answered = true;
                            break;
                        }
                        Err(e) => {
                            log::warn!("[OCR] JSON 解析失败: {} raw={:.200}", e, line);
                        }
                    }
                }
                Ok(Err(e)) => {
                    let _ = req.tx.send(Err(e));
                    answered = true;
                    if let Ok(mut st) = state.lock() {
                        st.ready = false;
                    }
                    break;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => break,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    let _ = req.tx.send(Err("OCR 读线程已退出".into()));
                    answered = true;
                    if let Ok(mut st) = state.lock() {
                        st.ready = false;
                    }
                    break;
                }
            }
        }

        if !answered {
            let _ = req.tx.send(Err("OCR 识别超时（20s）".into()));
            if let Ok(mut st) = state.lock() {
                st.ready = false;
                if let Some(mut p) = st.process.take() {
                    let _ = p.kill();
                    let _ = p.wait();
                }
            }
            break;
        }
    }
}

fn get_engine_path() -> PathBuf {
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join("rapidocr")
        .join("RapidOCR-json.exe");
    if dev.exists() {
        return dev;
    }
    if let Ok(exe) = std::env::current_exe() {
        let bundle = exe
            .parent()
            .unwrap_or(&exe)
            .join("rapidocr")
            .join("RapidOCR-json.exe");
        if bundle.exists() {
            return bundle;
        }
    }
    dev
}

// ─── Commands ───

#[tauri::command]
pub async fn ocr_recognize(
    state: tauri::State<'_, OcrEngine>,
    image_base64: String,
) -> Result<Value, String> {
    if image_base64.is_empty() {
        return Ok(serde_json::json!({ "code": 299, "data": "图片数据为空" }));
    }

    let image_base64 = image_base64
        .split(',')
        .last()
        .unwrap_or(&image_base64)
        .to_string();

    if image_base64.len() > 50 * 1024 * 1024 {
        return Ok(serde_json::json!({
            "code": 299,
            "data": "图片数据过大，请缩小选区"
        }));
    }

    log::info!(
        "[OCR] 开始识别 base64_len={} engine={}",
        image_base64.len(),
        state.path().display()
    );

    // 内部已有队列与 recv_timeout
    let result = state.recognize(image_base64);

    match result {
        Ok(resp) => {
            log::info!("[OCR] 完成 code={}", resp.code);
            Ok(serde_json::to_value(resp).unwrap_or_else(|_| {
                serde_json::json!({ "code": 299, "data": "序列化失败" })
            }))
        }
        Err(e) => {
            log::error!("[OCR] 失败: {}", e);
            Ok(serde_json::json!({ "code": 299, "data": e }))
        }
    }
}

#[tauri::command]
pub async fn ocr_is_ready(state: tauri::State<'_, OcrEngine>) -> Result<bool, String> {
    Ok(state.path().exists())
}

#[tauri::command]
pub async fn ocr_engine_status(state: tauri::State<'_, OcrEngine>) -> Result<Value, String> {
    Ok(serde_json::json!({
        "ready": state.path().exists(),
        "engine_ready": state.is_engine_ready(),
        "engine_path": state.path().to_string_lossy(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 回归：并发请求不应重复拉起引擎（TOCTOU）。
    /// 需要假引擎：设置 FAKE_OCR_EXE 指向它，FAKE_OCR_LOG 指向启动记录文件；未设置则跳过。
    #[test]
    fn concurrent_requests_start_engine_once() {
        let (exe, log) = match (std::env::var("FAKE_OCR_EXE"), std::env::var("FAKE_OCR_LOG")) {
            (Ok(e), Ok(l)) => (PathBuf::from(e), PathBuf::from(l)),
            _ => {
                eprintln!("跳过：未设置 FAKE_OCR_EXE / FAKE_OCR_LOG");
                return;
            }
        };
        let _ = std::fs::remove_file(&log);
        let engine = Arc::new(OcrEngine::with_engine_path(exe));

        let handles: Vec<_> = (0..4)
            .map(|_| {
                let e = Arc::clone(&engine);
                thread::spawn(move || e.recognize("aGk=".into()))
            })
            .collect();
        let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        engine.shutdown();

        let launches = std::fs::read_to_string(&log)
            .unwrap_or_default()
            .lines()
            .filter(|l| !l.trim().is_empty())
            .count();
        assert_eq!(launches, 1, "引擎被重复拉起 {launches} 次");
        for r in results {
            assert!(r.is_ok(), "并发请求不应因互相杀进程而失败: {r:?}");
        }
    }

    #[test]
    fn test_ocr_response_parse_success() {
        let json = r#"{"code":100,"data":[{"text":"hello","box":[[0,0],[1,0],[1,1],[0,1]],"score":0.99}]}"#;
        let resp: OcrResponse = serde_json::from_str(json).unwrap();
        assert_eq!(resp.code, 100);
        assert!(resp.data.is_array());
    }

    #[test]
    fn test_ocr_response_parse_error() {
        let json = r#"{"code":101,"data":"image decode failed"}"#;
        let resp: OcrResponse = serde_json::from_str(json).unwrap();
        assert_eq!(resp.code, 101);
    }

    #[test]
    fn test_engine_path_points_to_exe() {
        let p = get_engine_path();
        assert!(p.to_string_lossy().contains("RapidOCR-json.exe"));
    }
}
