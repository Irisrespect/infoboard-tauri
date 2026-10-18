//! 网盘多连接分片下载
//!
//! 免费账号在网盘侧通常被单连接限速，"高速"的唯一通用手段就是**并发分片**：
//! 先探测服务端是否支持 `Range`，支持就开 N 个连接各下自己那一段，用
//! 随机写（Windows `seek_write` / Unix `write_at`）直接写进同一个文件的对应偏移，
//! 免去"下成一堆分片再合并"的二次 IO。
//!
//! 进度不做事件推送：外部插件 import 不到 `@tauri-apps/api/event`，无法 listen，
//! 所以进度由插件轮询 `netdisk_download_status` 获取。

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

use super::domain::url_allowed;
use super::http::{check_cookie_size, cookie_header, DEFAULT_UA};

/// 单个分片的最小字节数。
///
/// 实测（夸克，2026-10）：同样 512 并发下，片的粒度直接决定吞吐 ——
/// **256KB/片 → 23.65 MB/s，512KB/片 → 12.94 MB/s，1MB/片 → 6.58 MB/s**。
/// 片越小，连接之间"等下一片"的空档越少。所以取 256KB。
const MIN_CHUNK_BYTES: u64 = 256 * 1024;
/// 目标片数 = 连接数 × 该倍数。
/// 实测要求"分片数必须 ≥ 并发数"，否则连接会空转
/// （626MB 用 2MB 分片只有 313 片，开 384 并发只跑出 4.9MB/s）。
const CHUNKS_PER_CONNECTION: u64 = 32;
/// 片数上限
const MAX_CHUNKS: u64 = 16384;
/// 并发连接上限。夸克这类 CDN 是"每连接限速"，社区实现普遍开到 32~64
const MAX_CONNECTIONS: usize = 64;
/// 单个分片的最大重试次数
const MAX_ATTEMPTS: u32 = 4;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadRequest {
    pub url: String,
    #[serde(default)]
    pub file_name: Option<String>,
    #[serde(default)]
    pub dest_dir: Option<String>,
    #[serde(default)]
    pub headers: Option<HashMap<String, String>>,
    /// Cookie 罐标识（与 netdisk_http_request 共用）
    #[serde(default)]
    pub session: Option<String>,
    /// 从哪个域取 Cookie 发给下载直链
    ///
    /// 网盘 API 用的域和 CDN 直链的域常常不是同一个可注册域（例如 API 在
    /// `pan.quark.cn`、直链在别的 CDN 上），此时按直链域名去罐子里找会一无所获。
    /// 插件把"登录时用的域"传进来，下载才能带上正确的登录态。
    #[serde(default)]
    pub cookie_host: Option<String>,
    /// 并发连接数（默认 16）
    #[serde(default)]
    pub connections: Option<usize>,
    #[serde(default)]
    pub allow_http: bool,
    /// 目标文件已存在时是否覆盖（默认另存为 "xxx (1).ext"）
    #[serde(default)]
    pub overwrite: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadStatus {
    pub id: String,
    /// running | done | failed | cancelled
    pub state: String,
    pub file_name: String,
    pub path: String,
    pub downloaded: u64,
    pub total: u64,
    /// 字节/秒（两次轮询之间估算，0 表示未知）
    pub speed: u64,
    pub connections: usize,
    pub error: Option<String>,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Running,
    /// 直链过期，已暂停，等插件送来新直链（见 `netdisk_download_relink`）
    Expired,
    Done,
    Failed,
    Cancelled,
}

impl State {
    fn as_str(self) -> &'static str {
        match self {
            State::Running => "running",
            State::Expired => "expired",
            State::Done => "done",
            State::Failed => "failed",
            State::Cancelled => "cancelled",
        }
    }
}

/// 一个待下载的分片
#[derive(Debug, Clone, Copy)]
struct Chunk {
    start: u64,
    end: u64,
    /// 被"慢分片抢占"重新排队的次数
    tries: u32,
}

/// 分片失败的性质 —— 决定是"换个链接接着下"还是"直接判死"
#[derive(Debug)]
enum ChunkError {
    /// 直链过期/被拒（401/403/404/412）：换新链后**从未完成的分片继续下**
    LinkExpired(String),
    /// 触发限流（429/503）：全局退避后重试
    Throttled(String),
    /// 慢分片：重新排队，换条连接试试
    Stalled(String),
    /// 其它错误
    Fatal(String),
}

impl ChunkError {
    fn message(&self) -> String {
        match self {
            ChunkError::LinkExpired(m)
            | ChunkError::Throttled(m)
            | ChunkError::Stalled(m)
            | ChunkError::Fatal(m) => m.clone(),
        }
    }
}

pub struct Job {
    id: String,
    /// 当前直链。可被 `netdisk_download_relink` 替换（直链 5~10 分钟就过期）
    url: Mutex<String>,
    /// 当前请求头（换链时一并更新）
    headers: Mutex<Vec<(String, String)>>,
    path: PathBuf,
    file_name: String,
    total: u64,
    connections: usize,
    /// 还没下完的分片（worker 从这里抢，抢完即空）
    queue: Mutex<VecDeque<Chunk>>,
    /// 有分片撞上直链过期，等插件换链
    relink_needed: AtomicBool,
    /// 每换一次链 +1，supervisor 靠它判断"新链到了"
    relink_epoch: AtomicU64,
    /// 全局退避截止时间（429/503 时所有 worker 一起等）
    backoff_until: Mutex<Option<Instant>>,
    downloaded: Arc<AtomicU64>,
    cancel: Arc<AtomicBool>,
    state: Mutex<State>,
    error: Mutex<Option<String>>,
    started: Instant,
    speed: AtomicU64,
    last_sample: Mutex<(Instant, u64)>,
}

impl Job {
    fn snapshot(&self) -> DownloadStatus {
        let downloaded = self.downloaded.load(Ordering::Relaxed);
        let state = *self.state.lock().unwrap_or_else(|e| e.into_inner());

        // 速度：用两次轮询之间的增量估算，间隔太短就不更新（避免抖动成 0）
        let mut speed = self.speed.load(Ordering::Relaxed);
        if let Ok(mut sample) = self.last_sample.lock() {
            let (last_at, last_bytes) = *sample;
            let dt = last_at.elapsed().as_secs_f64();
            if dt >= 0.4 {
                let delta = downloaded.saturating_sub(last_bytes);
                speed = (delta as f64 / dt) as u64;
                self.speed.store(speed, Ordering::Relaxed);
                *sample = (Instant::now(), downloaded);
            }
        }
        if state != State::Running {
            speed = 0;
        }

        DownloadStatus {
            id: self.id.clone(),
            state: state.as_str().to_string(),
            file_name: self.file_name.clone(),
            path: self.path.to_string_lossy().to_string(),
            downloaded,
            total: self.total,
            speed,
            connections: self.connections,
            error: self.error.lock().ok().and_then(|e| e.clone()),
            elapsed_ms: self.started.elapsed().as_millis() as u64,
        }
    }

    fn finish(&self, state: State, error: Option<String>) {
        if let Ok(mut s) = self.state.lock() {
            // 已被取消的任务不再被"失败"覆盖，否则 UI 会闪一下报错
            if *s == State::Cancelled {
                return;
            }
            *s = state;
        }
        if let Ok(mut e) = self.error.lock() {
            *e = error;
        }
    }
}

fn jobs() -> &'static Mutex<HashMap<String, Arc<Job>>> {
    static JOBS: OnceLock<Mutex<HashMap<String, Arc<Job>>>> = OnceLock::new();
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

// ─── 随机写（不移动文件游标，多个连接才能安全并发写同一个文件）───

#[cfg(windows)]
fn write_all_at(file: &File, buf: &[u8], offset: u64) -> std::io::Result<()> {
    use std::os::windows::fs::FileExt;
    let mut written = 0usize;
    while written < buf.len() {
        match file.seek_write(&buf[written..], offset + written as u64) {
            Ok(0) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::WriteZero,
                    "写入 0 字节",
                ))
            }
            Ok(n) => written += n,
            Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

#[cfg(unix)]
fn write_all_at(file: &File, buf: &[u8], offset: u64) -> std::io::Result<()> {
    use std::os::unix::fs::FileExt;
    let mut written = 0usize;
    while written < buf.len() {
        match file.write_at(&buf[written..], offset + written as u64) {
            Ok(0) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::WriteZero,
                    "写入 0 字节",
                ))
            }
            Ok(n) => written += n,
            Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

/// 兜底平台：全局锁 + seek，慢但正确
#[cfg(not(any(windows, unix)))]
fn write_all_at(file: &File, buf: &[u8], offset: u64) -> std::io::Result<()> {
    use std::io::{Seek, SeekFrom, Write};
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    let lock = LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock.lock().map_err(|_| std::io::Error::other("锁失效"))?;
    let mut f = file.try_clone()?;
    f.seek(SeekFrom::Start(offset))?;
    f.write_all(buf)
}

// ─── 文件名处理 ───

pub fn sanitize_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if (c as u32) < 0x20 => '_',
            c => c,
        })
        .collect();
    let mut trimmed = cleaned.trim().trim_end_matches(['.', ' ']).to_string();
    if trimmed.is_empty() {
        trimmed = "download.bin".to_string();
    }
    // 路径长度限制（Windows 260 的老问题）：保留扩展名，截断主干
    if trimmed.chars().count() > 150 {
        let ext = Path::new(&trimmed)
            .extension()
            .map(|e| e.to_string_lossy().to_string())
            .unwrap_or_default();
        let stem: String = trimmed.chars().take(140).collect();
        trimmed = if ext.is_empty() {
            stem
        } else {
            format!("{stem}.{ext}")
        };
    }
    trimmed
}

/// 已存在时另存为 "名字 (1).ext"
fn unique_path(dir: &Path, file_name: &str, overwrite: bool) -> PathBuf {
    let candidate = dir.join(file_name);
    if overwrite || !candidate.exists() {
        return candidate;
    }
    let path = Path::new(file_name);
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| file_name.to_string());
    let ext = path
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    for n in 1..10_000 {
        let p = dir.join(format!("{stem} ({n}){ext}"));
        if !p.exists() {
            return p;
        }
    }
    dir.join(format!("{stem}-{}{ext}", chrono::Utc::now().timestamp()))
}

/// 从 URL / Content-Disposition 猜文件名
fn guess_file_name(url: &str, disposition: Option<&str>) -> String {
    if let Some(cd) = disposition {
        for part in cd.split(';') {
            let p = part.trim();
            if let Some(rest) = p.strip_prefix("filename*=") {
                // RFC 5987: UTF-8''%E4%B8%AD%E6%96%87.zip
                let rest = rest.rsplit("''").next().unwrap_or(rest);
                if let Ok(decoded) = percent_decode(rest.trim_matches('"')) {
                    if !decoded.trim().is_empty() {
                        return sanitize_file_name(&decoded);
                    }
                }
            }
            if let Some(rest) = p.strip_prefix("filename=") {
                let v = rest.trim().trim_matches('"');
                if !v.is_empty() {
                    return sanitize_file_name(v);
                }
            }
        }
    }
    if let Ok(u) = url::Url::parse(url) {
        if let Some(seg) = u.path_segments().and_then(|s| s.last()) {
            if !seg.is_empty() {
                if let Ok(decoded) = percent_decode(seg) {
                    let name = sanitize_file_name(&decoded);
                    // 纯数字/无扩展名的路径段（如各种 dlink 的 id）不适合当文件名
                    if Path::new(&name).extension().is_some() {
                        return name;
                    }
                }
            }
        }
    }
    format!("netdisk-{}.bin", chrono::Utc::now().timestamp())
}

fn percent_decode(input: &str) -> Result<String, String> {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).map_err(|e| e.to_string())?;
            let v = u8::from_str_radix(hex, 16).map_err(|e| e.to_string())?;
            out.push(v);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|e| e.to_string())
}

// ─── 探测 ───

struct Probe {
    total: u64,
    ranged: bool,
    final_url: String,
    disposition: Option<String>,
}

/// 用 `Range: bytes=0-0` 探测：是否支持分片、总长度、最终 URL、文件名
async fn probe(
    client: &reqwest::Client,
    url: &str,
    headers: &[(String, String)],
) -> Result<Probe, String> {
    let mut rb = client.get(url).header(reqwest::header::RANGE, "bytes=0-0");
    for (k, v) in headers {
        if k.eq_ignore_ascii_case("range") {
            continue;
        }
        if let (Ok(n), Ok(val)) = (
            reqwest::header::HeaderName::from_bytes(k.as_bytes()),
            reqwest::header::HeaderValue::from_str(v),
        ) {
            rb = rb.header(n, val);
        }
    }
    let resp = rb
        .send()
        .await
        .map_err(|e| format!("探测失败: {}", e.without_url()))?;

    let status = resp.status();
    if status.as_u16() == 416 {
        return Err("文件为空或不可下载（416）".into());
    }
    if !status.is_success() {
        return Err(format!(
            "下载地址不可用: {}",
            explain_download_status(status.as_u16())
        ));
    }

    let final_url = resp.url().to_string();
    let disposition = resp
        .headers()
        .get(reqwest::header::CONTENT_DISPOSITION)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    let content_range = resp
        .headers()
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let content_length = resp
        .headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok());

    // 206 + Content-Range: bytes 0-0/12345 → 支持分片且知道总长
    let (ranged, total) = match (status.as_u16(), content_range.as_deref()) {
        (206, Some(cr)) => {
            let total = cr
                .rsplit('/')
                .next()
                .and_then(|s| s.trim().parse::<u64>().ok())
                .unwrap_or(0);
            (true, total)
        }
        _ => (false, content_length.unwrap_or(0)),
    };

    // 探测响应体不读，直接丢弃
    drop(resp);

    Ok(Probe {
        total,
        ranged,
        final_url,
        disposition,
    })
}

// ─── 分片计划 ───

/// 把文件切成多少片、每片多大（纯函数，便于测试）
///
/// 关键：**片数远多于连接数**（约 8 倍）。这样每个连接下完一片就回来抢下一片，
/// 快的连接自然多干活 —— 静态等分（一人一段）会让整体速度卡在最慢的那个连接上，
/// 表现为"尾部掉速/停滞"。
pub fn plan_chunks(total: u64, connections: usize) -> (u64, u64) {
    let conns = connections.max(1) as u64;
    let mut chunk_size = std::cmp::max(total / (conns * CHUNKS_PER_CONNECTION), MIN_CHUNK_BYTES);
    let mut count = total.div_ceil(chunk_size.max(1));
    if count > MAX_CHUNKS {
        chunk_size = total.div_ceil(MAX_CHUNKS);
        count = total.div_ceil(chunk_size.max(1));
    }
    (chunk_size, count.max(1))
}

// ─── 分片下载 ───

/// 把下载请求的失败状态码翻成一句能指导用户的话
///
/// 网盘的下载直链不是长期有效的：夸克实测 **5~10 分钟**就过期（9GB 文件按 9MB/s
/// 跑 17 分钟会撞上 2~4 次），过期后统一表现为 401/403/412。用户看到"HTTP 403"
/// 只会一头雾水，所以要明确告诉他是"链接过期、需要重新解析"。
pub fn explain_download_status(code: u16) -> String {
    match code {
        401 | 403 | 412 => format!(
            "HTTP {code}：直链已过期或被拒绝。网盘直链通常只有 5~10 分钟有效期，\
             大文件请在重新解析后立刻下载（也可能是并发过高触发了风控，可调低连接数再试）"
        ),
        429 | 503 => format!("HTTP {code}：触发服务端限流，请调低并发连接数后重试"),
        404 => "HTTP 404：直链已失效（文件可能已被删除或移动）".to_string(),
        other => format!("HTTP {other}"),
    }
}

#[allow(clippy::too_many_arguments)]
async fn fetch_range(
    client: reqwest::Client,
    job: Arc<Job>,
    file: Arc<File>,
    start: u64,
    end: u64,
    headers: Vec<(String, String)>,
) -> Result<(), ChunkError> {
    let mut pos = start;
    let mut attempt: u32 = 0;
    let mut stall: u32 = 0;

    while pos <= end {
        if job.cancel.load(Ordering::Relaxed) {
            return Ok(());
        }
        wait_for_backoff(&job).await;

        // 每次请求都重新读直链 —— 换链后这里拿到的是新地址
        let current_url = job.url.lock().map(|u| u.clone()).unwrap_or_default();
        let mut rb = client
            .get(&current_url)
            .header(reqwest::header::RANGE, format!("bytes={pos}-{end}"));
        for (k, v) in &headers {
            if k.eq_ignore_ascii_case("range") {
                continue;
            }
            if let (Ok(n), Ok(val)) = (
                reqwest::header::HeaderName::from_bytes(k.as_bytes()),
                reqwest::header::HeaderValue::from_str(v),
            ) {
                rb = rb.header(n, val);
            }
        }

        let send = rb.send().await;
        let mut resp = match send {
            Ok(r) => r,
            Err(e) => {
                attempt += 1;
                if attempt >= MAX_ATTEMPTS {
                    return Err(ChunkError::Fatal(format!("连接失败: {}", e.without_url())));
                }
                tokio::time::sleep(Duration::from_millis(400 * attempt as u64)).await;
                continue;
            }
        };

        let status = resp.status();
        if !status.is_success() {
            let code = status.as_u16();
            // 直链过期/被拒：不再自己傻等重试，而是交给 supervisor 换链后接着下。
            // 注意这里**不是**失败 —— 未完成的分片会被放回队列，换链后继续。
            if matches!(code, 401 | 403 | 404 | 412) {
                return Err(ChunkError::LinkExpired(explain_download_status(code)));
            }
            if matches!(code, 429 | 503) {
                begin_backoff(&job, attempt);
                return Err(ChunkError::Throttled(explain_download_status(code)));
            }
            attempt += 1;
            if attempt >= MAX_ATTEMPTS {
                return Err(ChunkError::Fatal(explain_download_status(code)));
            }
            tokio::time::sleep(Duration::from_millis(400 * attempt as u64)).await;
            continue;
        }
        // 服务端忽略 Range（回 200 全量）时，只有"整个文件、从头开始"才安全，
        // 否则会把全量数据写到分片偏移上，直接把文件写坏
        if status.as_u16() == 200 && !(start == 0 && pos == 0) {
            return Err(ChunkError::Fatal(
                "服务端忽略了 Range 请求，无法分片下载".into(),
            ));
        }

        let before = pos;
        let mut cursor = pos;
        let mut failure: Option<ChunkError> = None;
        /// 慢分片判定：这么久没动静就重新排队（换条连接往往立刻就好了）
        const SLOW_CHUNK_GRACE: Duration = Duration::from_secs(15);

        loop {
            if job.cancel.load(Ordering::Relaxed) {
                return Ok(());
            }
            match tokio::time::timeout(SLOW_CHUNK_GRACE, resp.chunk()).await {
                // 超时：这条连接卡住了，把这个分片交回队列（已写下的字节仍然有效，
                // 重新排队后会从 pos 续传，不会重下）
                Err(_) => {
                    failure = Some(ChunkError::Stalled(format!(
                        "分片 {pos}-{end} 超过 {} 秒没有数据，已重新排队",
                        SLOW_CHUNK_GRACE.as_secs()
                    )));
                    break;
                }
                Ok(Ok(Some(chunk))) => {
                    if chunk.is_empty() {
                        continue;
                    }
                    let remaining = end + 1 - cursor;
                    if remaining == 0 {
                        break;
                    }
                    let take = std::cmp::min(remaining, chunk.len() as u64) as usize;
                    write_all_at(&file, &chunk[..take], cursor)
                        .map_err(|e| ChunkError::Fatal(format!("写文件失败: {e}")))?;
                    cursor += take as u64;
                    job.downloaded.fetch_add(take as u64, Ordering::Relaxed);
                    attempt = 0;
                    if take < chunk.len() {
                        break;
                    }
                }
                Ok(Ok(None)) => break,
                Ok(Err(e)) => {
                    failure = Some(ChunkError::Fatal(format!("读取中断: {}", e.without_url())));
                    break;
                }
            }
        }

        if let Some(err) = failure {
            // 慢分片 / 限流：交回队列让别的连接试试，不算这个分片失败
            if !matches!(err, ChunkError::Fatal(_)) {
                return Err(err);
            }
            attempt += 1;
            if attempt >= MAX_ATTEMPTS {
                return Err(err);
            }
            tokio::time::sleep(Duration::from_millis(400 * attempt as u64)).await;
            continue;
        }

        pos = cursor;
        if pos <= end {
            // 服务端提前断开：没进展就累计停滞次数，有进展就继续续传
            if pos == before {
                stall += 1;
                if stall >= 3 {
                    return Err(ChunkError::Stalled(format!(
                        "分片 {start}-{end} 连续 3 轮没有进展，已重新排队"
                    )));
                }
            } else {
                stall = 0;
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
    }
    Ok(())
}

// ─── 全局退避（429/503）───

/// 触发限流后，让**所有** worker 一起静默一段时间再继续
///
/// 只退避当前这一个分片是没用的：限流是服务端对这个账号/这条链路的，
/// 其它连接继续猛冲只会让惩罚更重。
fn begin_backoff(job: &Job, attempt: u32) {
    // 首次 30 秒，之后随重试次数翻倍，最多 5 分钟
    let secs = std::cmp::min(30u64 << attempt.min(4), 300);
    if let Ok(mut until) = job.backoff_until.lock() {
        let target = Instant::now() + Duration::from_secs(secs);
        // 只延长、不缩短（多个 worker 同时撞限流时取最保守的那个）
        if until.map(|u| u < target).unwrap_or(true) {
            *until = Some(target);
        }
    }
}

async fn wait_for_backoff(job: &Job) {
    loop {
        let wait = {
            let Ok(guard) = job.backoff_until.lock() else {
                return;
            };
            match *guard {
                Some(until) => until.checked_duration_since(Instant::now()),
                None => None,
            }
        };
        match wait {
            Some(d) if !d.is_zero() => {
                // 退避期间也要能被取消
                tokio::time::sleep(std::cmp::min(d, Duration::from_millis(500))).await;
            }
            _ => return,
        }
    }
}

// ─── 命令 ───

fn default_download_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .download_dir()
        .ok()
        .or_else(|| {
            std::env::var("USERPROFILE")
                .ok()
                .map(|p| PathBuf::from(p).join("Downloads"))
        })
        .unwrap_or_else(|| std::env::temp_dir())
}

#[tauri::command]
pub fn netdisk_default_download_dir(app: AppHandle) -> String {
    default_download_dir(&app).to_string_lossy().to_string()
}

#[tauri::command]
pub async fn netdisk_download_start(
    app: AppHandle,
    req: DownloadRequest,
) -> Result<DownloadStatus, String> {
    let parsed = url_allowed(&req.url, req.allow_http)?;
    let host = parsed.host_str().unwrap_or_default().to_string();

    // 目标目录
    let dest_dir = req
        .dest_dir
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| default_download_dir(&app));
    std::fs::create_dir_all(&dest_dir).map_err(|e| format!("创建目录失败 {dest_dir:?}: {e}"))?;

    // 请求头：Cookie 罐 + 插件显式头（显式优先）
    // 取 Cookie 的域优先用插件给的 cookieHost（登录时用的域），其次才用直链自己的域
    let cookie_source = req
        .cookie_host
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(host.as_str());
    let mut headers: Vec<(String, String)> = Vec::new();
    if let Some(c) = cookie_header(req.session.as_deref(), cookie_source) {
        // "把浏览器全部 Cookie 都粘进来"会被服务端掐断连接，提前给出可照做的报错
        check_cookie_size(&c)?;
        headers.push(("Cookie".into(), c));
    }
    if let Some(h) = &req.headers {
        for (k, v) in h {
            headers.retain(|(ek, _)| !ek.eq_ignore_ascii_case(k));
            headers.push((k.clone(), v.clone()));
        }
    }
    if !headers
        .iter()
        .any(|(k, _)| k.eq_ignore_ascii_case("user-agent"))
    {
        headers.push(("User-Agent".into(), DEFAULT_UA.to_string()));
    }

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        // 大文件下载不能设总超时，否则下到一半必被掐断；只留连接超时
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 {
                return attempt.error("重定向次数过多");
            }
            let ok = attempt
                .url()
                .host_str()
                .map(super::domain::host_allowed)
                .unwrap_or(false);
            if ok {
                attempt.follow()
            } else {
                attempt.error("重定向目标不在白名单")
            }
        }))
        .build()
        .map_err(|e| format!("HTTP 客户端创建失败: {e}"))?;

    let job = start_download(
        client,
        parsed.to_string(),
        headers,
        dest_dir,
        req.file_name.clone(),
        req.connections.unwrap_or(16),
        req.overwrite,
    )
    .await?;
    crate::core::app_log::emit(
        &app,
        "info",
        &format!(
            "[netdisk] 开始下载 {} ({} 字节, {} 连接) → {}",
            job.file_name,
            job.total,
            job.connections,
            job.path.display()
        ),
    );

    Ok(job.snapshot())
}

/// 下载核心：探测 → 建文件 → 切分片 → 并发拉取
///
/// 与 Tauri 命令解耦，便于用本地 HTTP 服务做集成测试（见文件末尾）。
pub async fn start_download(
    client: reqwest::Client,
    url: String,
    headers: Vec<(String, String)>,
    dest_dir: PathBuf,
    file_name: Option<String>,
    connections_wanted: usize,
    overwrite: bool,
) -> Result<Arc<Job>, String> {
    let probe = probe(&client, &url, &headers).await?;

    let file_name = file_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(sanitize_file_name)
        .unwrap_or_else(|| guess_file_name(&probe.final_url, probe.disposition.as_deref()));

    let path = unique_path(&dest_dir, &file_name, overwrite);
    let total = probe.total;

    // 并发数：服务端支持 Range 且文件足够大才值得分片
    let wanted = connections_wanted.clamp(1, MAX_CONNECTIONS);
    let connections = if probe.ranged && total > MIN_CHUNK_BYTES {
        std::cmp::min(wanted as u64, std::cmp::max(1, total / MIN_CHUNK_BYTES)) as usize
    } else {
        1
    };

    let file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&path)
        .map_err(|e| format!("创建文件失败 {path:?}: {e}"))?;
    if total > 0 {
        file.set_len(total)
            .map_err(|e| format!("预分配文件失败: {e}"))?;
    }
    let file = Arc::new(file);

    let id = format!("dl-{}", chrono::Utc::now().timestamp_millis());
    // 落盘名可能与请求名不同（重名时另存为 "x (1).ext"），以实际路径为准
    let final_name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or(file_name);
    // 分片队列：每个分片带着"被抢占过几次"，避免慢分片无限重排队
    let planned: VecDeque<Chunk> = if connections <= 1 || total == 0 {
        VecDeque::from([Chunk {
            start: 0,
            end: if total == 0 { u64::MAX - 1 } else { total - 1 },
            tries: 0,
        }])
    } else {
        let (chunk_size, chunk_count) = plan_chunks(total, connections);
        (0..chunk_count)
            .map(|i| {
                let start = i * chunk_size;
                Chunk {
                    start,
                    end: std::cmp::min(start + chunk_size, total) - 1,
                    tries: 0,
                }
            })
            .collect()
    };

    let job = Arc::new(Job {
        id: id.clone(),
        url: Mutex::new(probe.final_url.clone()),
        headers: Mutex::new(headers.clone()),
        path: path.clone(),
        file_name: final_name.clone(),
        total,
        connections,
        queue: Mutex::new(planned),
        relink_needed: AtomicBool::new(false),
        relink_epoch: AtomicU64::new(0),
        backoff_until: Mutex::new(None),
        downloaded: Arc::new(AtomicU64::new(0)),
        cancel: Arc::new(AtomicBool::new(false)),
        state: Mutex::new(State::Running),
        error: Mutex::new(None),
        started: Instant::now(),
        speed: AtomicU64::new(0),
        last_sample: Mutex::new((Instant::now(), 0)),
    });

    if let Ok(mut map) = jobs().lock() {
        map.insert(id.clone(), job.clone());
    }

    // 分片任务：动态队列 + 抢占式取片 + 直链过期自愈
    let job_for_task = job.clone();
    let client_for_task = client.clone();
    let headers_for_task = headers.clone();
    tokio::spawn(async move {
        /// 换链最多等这么久，超时就判失败（插件那边可能已经关掉面板了）
        const RELINK_WAIT: Duration = Duration::from_secs(180);
        /// 一个分片最多被"慢分片抢占"重新排队几次
        const MAX_STALL_REQUEUE: u32 = 3;

        let mut relink_round = 0u32;
        loop {
            // ── 起一轮 worker，把队列里剩下的分片抢完 ──
            let mut tasks = Vec::new();
            for _ in 0..connections.max(1) {
                let j = job_for_task.clone();
                let c = client_for_task.clone();
                let h = headers_for_task.clone();
                let f = file.clone();
                tasks.push(tokio::spawn(async move {
                    loop {
                        if j.cancel.load(Ordering::Relaxed) {
                            return Ok(());
                        }
                        let chunk = {
                            let Ok(mut q) = j.queue.lock() else {
                                return Err(ChunkError::Fatal("分片队列锁失效".into()));
                            };
                            q.pop_front()
                        };
                        let Some(chunk) = chunk else {
                            return Ok(()); // 队列空了，这一轮干完了
                        };

                        match fetch_range(
                            c.clone(),
                            j.clone(),
                            f.clone(),
                            chunk.start,
                            chunk.end,
                            h.clone(),
                        )
                        .await
                        {
                            Ok(()) => {}
                            Err(ChunkError::LinkExpired(msg)) => {
                                // 把这片放回**队首**，换链后优先接着下
                                if let Ok(mut q) = j.queue.lock() {
                                    q.push_front(chunk);
                                }
                                j.relink_needed.store(true, Ordering::Relaxed);
                                return Err(ChunkError::LinkExpired(msg));
                            }
                            Err(ChunkError::Throttled(msg)) => {
                                // 限流：放回队尾，等全局退避结束再试
                                if let Ok(mut q) = j.queue.lock() {
                                    q.push_back(chunk);
                                }
                                return Err(ChunkError::Throttled(msg));
                            }
                            Err(ChunkError::Stalled(msg)) => {
                                if chunk.tries + 1 >= MAX_STALL_REQUEUE {
                                    return Err(ChunkError::Fatal(format!(
                                        "{msg}（已重排 {MAX_STALL_REQUEUE} 次仍无进展）"
                                    )));
                                }
                                if let Ok(mut q) = j.queue.lock() {
                                    q.push_back(Chunk {
                                        tries: chunk.tries + 1,
                                        ..chunk
                                    });
                                }
                                // 换下一个分片继续，不占着这条连接
                            }
                            Err(e) => return Err(e),
                        }
                    }
                }));
            }

            // ── 收拢这一轮的结果 ──
            let mut fatal: Option<String> = None;
            let mut expired: Option<String> = None;
            let mut throttled = false;
            for t in tasks {
                match t.await {
                    Ok(Ok(())) => {}
                    Ok(Err(ChunkError::LinkExpired(m))) => expired = Some(m),
                    Ok(Err(ChunkError::Throttled(_))) => throttled = true,
                    Ok(Err(e)) => {
                        if fatal.is_none() {
                            fatal = Some(e.message());
                        }
                    }
                    Err(e) => {
                        if fatal.is_none() {
                            fatal = Some(format!("下载任务异常: {e}"));
                        }
                    }
                }
            }

            if job_for_task.cancel.load(Ordering::Relaxed) {
                job_for_task.finish(State::Cancelled, None);
                return;
            }
            if let Some(e) = fatal {
                job_for_task.cancel.store(true, Ordering::Relaxed);
                job_for_task.finish(State::Failed, Some(e));
                return;
            }

            // 限流：退避结束后再开一轮（不计换链次数）
            if throttled && !job_for_task.relink_needed.load(Ordering::Relaxed) {
                // 有一轮 worker 全被限流挡回来时，等退避窗口过去再继续
                wait_for_backoff(&job_for_task).await;
                continue;
            }

            // 直链过期：挂起等插件送新链，然后从未完成的分片继续
            if let Some(msg) = expired {
                if job_for_task.relink_needed.load(Ordering::Relaxed) {
                    relink_round += 1;
                    if relink_round > 5 {
                        job_for_task.finish(
                            State::Failed,
                            Some(format!("{msg}（已自动换链 5 次仍未下完，请稍后重试）")),
                        );
                        return;
                    }
                    job_for_task.finish(State::Expired, Some(msg));
                    let epoch = job_for_task.relink_epoch.load(Ordering::Relaxed);
                    if !wait_for_relink(&job_for_task, epoch, RELINK_WAIT).await {
                        if job_for_task.cancel.load(Ordering::Relaxed) {
                            job_for_task.finish(State::Cancelled, None);
                        } else {
                            job_for_task.finish(
                                State::Failed,
                                Some("直链已过期，但 3 分钟内没等到新的直链".to_string()),
                            );
                        }
                        return;
                    }
                    // 新链到手：清掉标记，状态回到 running，继续抢剩下的分片
                    job_for_task.relink_needed.store(false, Ordering::Relaxed);
                    if let Ok(mut s) = job_for_task.state.lock() {
                        *s = State::Running;
                    }
                    if let Ok(mut e) = job_for_task.error.lock() {
                        *e = None;
                    }
                    continue;
                }
            }

            let left = job_for_task.queue.lock().map(|q| q.len()).unwrap_or(0);
            if left > 0 {
                // 队列还有货但这一轮没人拿到（例如全被限流挡回），再来一轮
                continue;
            }

            let got = job_for_task.downloaded.load(Ordering::Relaxed);
            if total > 0 && got < total {
                job_for_task.finish(
                    State::Failed,
                    Some(format!("下载不完整：{got}/{total} 字节")),
                );
                return;
            }
            job_for_task.finish(State::Done, None);
            return;
        }
    });

    Ok(job)
}

/// 等插件送来新直链（`relink_epoch` 变化即视为"新链到了"）
async fn wait_for_relink(job: &Job, epoch_before: u64, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if job.cancel.load(Ordering::Relaxed) {
            return false;
        }
        if job.relink_epoch.load(Ordering::Relaxed) != epoch_before {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    false
}

#[tauri::command]
pub fn netdisk_download_status(id: String) -> Result<DownloadStatus, String> {
    let map = jobs().lock().map_err(|_| "任务表锁失效".to_string())?;
    map.get(&id)
        .map(|j| j.snapshot())
        .ok_or_else(|| format!("任务不存在: {id}"))
}

#[tauri::command]
pub fn netdisk_download_list() -> Vec<DownloadStatus> {
    let Ok(map) = jobs().lock() else {
        return Vec::new();
    };
    let mut out: Vec<DownloadStatus> = map.values().map(|j| j.snapshot()).collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

#[tauri::command]
pub fn netdisk_download_cancel(id: String) -> Result<(), String> {
    let map = jobs().lock().map_err(|_| "任务表锁失效".to_string())?;
    let job = map.get(&id).ok_or_else(|| format!("任务不存在: {id}"))?;
    job.cancel.store(true, Ordering::Relaxed);
    job.finish(State::Cancelled, None);
    Ok(())
}

/// 给一个"直链已过期"的任务换上新的直链，然后**从未完成的分片继续下载**
///
/// 为什么需要它：网盘直链只有 5~10 分钟有效期，大文件必然中途过期。
/// 插件轮询到 `state == "expired"` 时重新解析一次分享，把新直链送到这里即可；
/// 已经下完的分片不会重下，只是把剩下的分片抢完。
#[tauri::command]
pub fn netdisk_download_relink(
    id: String,
    url: String,
    headers: Option<HashMap<String, String>>,
    allow_http: Option<bool>,
) -> Result<DownloadStatus, String> {
    // 新直链同样是不可信输入：仍然要过白名单
    url_allowed(&url, allow_http.unwrap_or(false))?;

    let map = jobs().lock().map_err(|_| "任务表锁失效".to_string())?;
    let job = map.get(&id).ok_or_else(|| format!("任务不存在: {id}"))?;
    apply_relink(job, url, headers)?;
    Ok(job.snapshot())
}

/// 换链的核心（与命令解耦，便于集成测试）
///
/// 只把新直链 / 新请求头写进任务并唤醒 supervisor；
/// 白名单校验留在命令层（与 `start_download` 的职责划分一致）。
pub fn apply_relink(
    job: &Arc<Job>,
    url: String,
    headers: Option<HashMap<String, String>>,
) -> Result<(), String> {
    {
        let mut guard = job.url.lock().map_err(|_| "直链锁失效".to_string())?;
        *guard = url;
    }
    if let Some(h) = headers {
        let mut guard = job.headers.lock().map_err(|_| "请求头锁失效".to_string())?;
        // 显式传的头覆盖同名旧头，其余保留（例如 Cookie）
        for (k, v) in h {
            guard.retain(|(ek, _)| !ek.eq_ignore_ascii_case(&k));
            guard.push((k, v));
        }
    }
    // 唤醒 supervisor：epoch 变化 = "新链到了"
    job.relink_epoch.fetch_add(1, Ordering::Relaxed);
    Ok(())
}

/// 在资源管理器里定位文件
#[tauri::command]
pub fn netdisk_reveal_in_explorer(path: String) -> Result<(), String> {
    let p = PathBuf::from(path.trim());
    if !p.exists() {
        return Err(format!("路径不存在: {}", p.display()));
    }
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", p.display()))
            .spawn()
            .map_err(|e| format!("打开资源管理器失败: {e}"))?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let dir = if p.is_dir() {
            p
        } else {
            p.parent().map(|d| d.to_path_buf()).unwrap_or(p)
        };
        std::process::Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map_err(|e| format!("打开文件管理器失败: {e}"))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 文件名清洗() {
        assert_eq!(sanitize_file_name("a/b\\c:d*e?f.txt"), "a_b_c_d_e_f.txt");
        assert_eq!(sanitize_file_name("  尾部点... "), "尾部点");
        assert_eq!(sanitize_file_name(""), "download.bin");
        assert_eq!(sanitize_file_name("正常 文件名.zip"), "正常 文件名.zip");
    }

    #[test]
    fn 文件名过长时保留扩展名() {
        let long = format!("{}.zip", "长".repeat(300));
        let out = sanitize_file_name(&long);
        assert!(out.ends_with(".zip"));
        assert!(out.chars().count() <= 150);
    }

    #[test]
    fn 重名时另存() {
        let dir = std::env::temp_dir().join(format!("netdisk-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("x.zip");
        std::fs::write(&f, b"1").unwrap();
        let p = unique_path(&dir, "x.zip", false);
        assert_eq!(p.file_name().unwrap().to_string_lossy(), "x (1).zip");
        let p2 = unique_path(&dir, "x.zip", true);
        assert_eq!(p2.file_name().unwrap().to_string_lossy(), "x.zip");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 从_disposition_猜文件名() {
        assert_eq!(
            guess_file_name("https://x.com/1", Some("attachment; filename=\"报告.pdf\"")),
            "报告.pdf"
        );
        assert_eq!(
            guess_file_name(
                "https://x.com/1",
                Some("attachment; filename*=UTF-8''%E4%B8%AD.zip")
            ),
            "中.zip"
        );
        assert_eq!(
            guess_file_name("https://x.com/a/b/电影.mkv?x=1", None),
            "电影.mkv"
        );
        // 无扩展名的 id 段不该被当成文件名
        assert!(guess_file_name("https://x.com/dl/123456789012", None).starts_with("netdisk-"));
    }

    #[test]
    fn 百分号解码() {
        assert_eq!(percent_decode("%E4%B8%AD").unwrap(), "中");
        assert_eq!(percent_decode("abc").unwrap(), "abc");
    }

    /// 分片计划：片数要明显多于连接数（供抢占），且单片不低于 256KB
    #[test]
    fn 分片计划_片数多于连接数() {
        let total = 1024u64 * 1024 * 1024; // 1GB
        let (size, count) = plan_chunks(total, 16);
        // 1GB / (16×32) = 2MB 一片
        assert_eq!(size, 2 * 1024 * 1024);
        assert_eq!(count, 512);
        assert!(count > 16, "片数必须多于连接数，否则没有抢占空间");
        // 覆盖完整，不重不漏
        assert!(size * count >= total);
        assert!(size * (count - 1) < total);
    }

    /// 回归实测结论：片越大越慢。626MB 在 512 并发下，2MB 分片只有 313 片会空转；
    /// 这里保证"片数 ≥ 连接数"始终成立
    #[test]
    fn 分片计划_片数始终不少于连接数() {
        for (total, conns) in [
            (626u64 * 1024 * 1024, 64usize),
            (626 * 1024 * 1024, 128),
            (10 * 1024 * 1024 * 1024, 64),
            (100 * 1024 * 1024, 8),
        ] {
            let (_, count) = plan_chunks(total, conns);
            assert!(
                count >= conns as u64,
                "{total} 字节 / {conns} 连接只切出 {count} 片，会让连接空转"
            );
        }
    }

    #[test]
    fn 分片计划_小文件退化为单片且不低于最小片长() {
        let (size, count) = plan_chunks(3 * 1024 * 1024, 32);
        assert_eq!(size, MIN_CHUNK_BYTES);
        assert_eq!(count, 3 * 1024 * 1024 / MIN_CHUNK_BYTES);
    }

    #[test]
    fn 分片计划_片数有上限() {
        // 超大文件 + 大并发也不能切出超过 MAX_CHUNKS 片
        let total = 400u64 * 1024 * 1024 * 1024; // 400GB
        let (size, count) = plan_chunks(total, 64);
        assert!(count <= MAX_CHUNKS, "片数 {count} 超过上限");
        assert!(size * count >= total, "切片必须覆盖整个文件");
    }

    #[test]
    fn 分片计划_边界() {
        let (size, count) = plan_chunks(1, 1);
        assert_eq!(size, MIN_CHUNK_BYTES);
        assert_eq!(count, 1);
        // 连接数为 0 也不能除零
        let (_, count0) = plan_chunks(10 * 1024 * 1024, 0);
        assert!(count0 >= 1);
    }

    /// 夸克直链 5~10 分钟就过期，表现为 401/403/412 —— 提示必须能指导用户
    #[test]
    fn 直链过期要给出可操作的提示() {
        for code in [401u16, 403, 412] {
            let msg = explain_download_status(code);
            assert!(msg.contains("过期"), "{code} 应说明链接已过期: {msg}");
            assert!(msg.contains("重新解析"), "{code} 应告诉用户怎么办: {msg}");
        }
        assert!(explain_download_status(429).contains("限流"));
        assert!(explain_download_status(503).contains("限流"));
        assert!(explain_download_status(404).contains("失效"));
        assert_eq!(explain_download_status(500), "HTTP 500");
    }
}

/// 端到端：起一个本地 HTTP 服务，真的跑一遍分片下载
///
/// 这是"高速下载"最核心的一段逻辑（切分片、随机写偏移、拼装成完整文件），
/// 也是最容易写错的地方，所以用真实 HTTP 往返验证，而不是只测纯函数。
#[cfg(test)]
mod integration_tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// 长度不是 2 的幂，且用非对齐的字节模式，偏移写错必然对不上
    fn pattern(len: usize) -> Vec<u8> {
        (0..len).map(|i| (i % 251) as u8).collect()
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("netdisk-it-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// 最小 HTTP 服务：`ranged=false` 时忽略 Range 头（模拟不支持分片的服务端）
    async fn spawn_server(data: Arc<Vec<u8>>, ranged: bool) -> std::net::SocketAddr {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    break;
                };
                let data = data.clone();
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 4096];
                    let Ok(n) = sock.read(&mut buf).await else {
                        return;
                    };
                    if n == 0 {
                        return;
                    }
                    let head = String::from_utf8_lossy(&buf[..n]).to_string();
                    let total = data.len();

                    let mut has_range = false;
                    let (mut start, mut end) = (0usize, total.saturating_sub(1));
                    for line in head.lines() {
                        if let Some(v) = line.to_ascii_lowercase().strip_prefix("range:") {
                            has_range = true;
                            let v = v.trim().trim_start_matches("bytes=").to_string();
                            let mut it = v.split('-');
                            start = it
                                .next()
                                .and_then(|s| s.trim().parse::<usize>().ok())
                                .unwrap_or(0);
                            end = it
                                .next()
                                .and_then(|s| {
                                    let t = s.trim();
                                    if t.is_empty() {
                                        None
                                    } else {
                                        t.parse::<usize>().ok()
                                    }
                                })
                                .unwrap_or(total.saturating_sub(1));
                        }
                    }
                    let end = end.min(total.saturating_sub(1));
                    let use_range = ranged && has_range;
                    let body: &[u8] = if use_range {
                        &data[start..=end]
                    } else {
                        &data[..]
                    };
                    let resp = if use_range {
                        format!(
                            "HTTP/1.1 206 Partial Content\r\nContent-Type: application/octet-stream\r\nAccept-Ranges: bytes\r\nContent-Range: bytes {start}-{end}/{total}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        )
                    } else {
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nAccept-Ranges: none\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        )
                    };
                    let _ = sock.write_all(resp.as_bytes()).await;
                    let _ = sock.write_all(body).await;
                    let _ = sock.shutdown().await;
                });
            }
        });
        addr
    }

    async fn wait_done(job: &Arc<Job>) -> DownloadStatus {
        for _ in 0..1200 {
            let s = job.snapshot();
            if s.state != "running" && s.state != "expired" {
                return s;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("下载超时未结束");
    }

    /// 等任务进入某个状态（用于"直链过期"这类中间态）
    async fn wait_state(job: &Arc<Job>, want: &str, timeout: Duration) -> DownloadStatus {
        let deadline = Instant::now() + timeout;
        loop {
            let s = job.snapshot();
            if s.state == want {
                return s;
            }
            if Instant::now() > deadline {
                panic!("等待状态 {want} 超时，当前 {} ({:?})", s.state, s.error);
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    /// 带"配额"的服务端：累计发出 `quota` 字节后开始一律 403，
    /// 模拟网盘直链到点过期。调用方把 `expired` 置回 false 即等于"换了条新链"。
    async fn spawn_quota_server(
        data: Arc<Vec<u8>>,
        quota: u64,
    ) -> (std::net::SocketAddr, Arc<AtomicU64>, Arc<AtomicBool>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let served = Arc::new(AtomicU64::new(0));
        let expired = Arc::new(AtomicBool::new(false));

        let served_task = served.clone();
        let expired_task = expired.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    break;
                };
                let data = data.clone();
                let served = served_task.clone();
                let expired = expired_task.clone();
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 4096];
                    let Ok(n) = sock.read(&mut buf).await else {
                        return;
                    };
                    if n == 0 {
                        return;
                    }
                    let head = String::from_utf8_lossy(&buf[..n]).to_string();
                    let total = data.len();

                    // 直链已过期：一律 403（真实网盘就是 401/403/412）
                    if expired.load(Ordering::Relaxed) {
                        let _ = sock
                            .write_all(
                                b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                            )
                            .await;
                        let _ = sock.shutdown().await;
                        return;
                    }

                    let mut has_range = false;
                    let (mut start, mut end) = (0usize, total.saturating_sub(1));
                    for line in head.lines() {
                        if let Some(v) = line.to_ascii_lowercase().strip_prefix("range:") {
                            has_range = true;
                            let v = v.trim().trim_start_matches("bytes=").to_string();
                            let mut it = v.split('-');
                            start = it
                                .next()
                                .and_then(|s| s.trim().parse::<usize>().ok())
                                .unwrap_or(0);
                            end = it
                                .next()
                                .and_then(|s| {
                                    let t = s.trim();
                                    if t.is_empty() {
                                        None
                                    } else {
                                        t.parse::<usize>().ok()
                                    }
                                })
                                .unwrap_or(total.saturating_sub(1));
                        }
                    }
                    let end = end.min(total.saturating_sub(1));
                    let body: &[u8] = if has_range {
                        &data[start..=end]
                    } else {
                        &data[..]
                    };
                    let resp = if has_range {
                        format!(
                            "HTTP/1.1 206 Partial Content\r\nAccept-Ranges: bytes\r\nContent-Range: bytes {start}-{end}/{total}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        )
                    } else {
                        format!(
                            "HTTP/1.1 200 OK\r\nAccept-Ranges: bytes\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        )
                    };
                    let _ = sock.write_all(resp.as_bytes()).await;
                    let _ = sock.write_all(body).await;
                    let _ = sock.shutdown().await;

                    // 配额用尽 → 从下一个请求开始过期
                    let done =
                        served.fetch_add(body.len() as u64, Ordering::Relaxed) + body.len() as u64;
                    if done >= quota {
                        expired.store(true, Ordering::Relaxed);
                    }
                });
            }
        });
        (addr, served, expired)
    }

    /// 直链自愈：下载中途直链过期 → 任务挂起为 expired → 换链 → 从未完成的分片继续
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn 直链过期后换链能从断点继续下完() {
        let data = Arc::new(pattern(8 * 1024 * 1024 + 555));
        // 只放行 2MB 就"过期"，保证中途必然撞上
        let (old_addr, _served, _expired) = spawn_quota_server(data.clone(), 2 * 1024 * 1024).await;
        // 第二个服务端代表"重新解析后拿到的新直链"—— 现实中它就是个新 URL
        // （往往还换了 CDN 域名），配额充足
        let (new_addr, _s2, _e2) = spawn_quota_server(data.clone(), u64::MAX).await;
        let dir = temp_dir("relink");

        let job = start_download(
            client(),
            format!("http://{old_addr}/movie.bin"),
            vec![],
            dir.clone(),
            Some("movie.bin".into()),
            4,
            true,
        )
        .await
        .expect("启动下载失败");
        assert_eq!(job.connections, 4);

        // 撞上过期后，任务应该进入 expired 而不是直接 failed
        let mid = wait_state(&job, "expired", Duration::from_secs(30)).await;
        assert!(mid.error.is_some(), "应带上说明，供 UI 提示");
        assert!(
            mid.downloaded > 0 && mid.downloaded < data.len() as u64,
            "中断时应已下了一部分（实得 {}）",
            mid.downloaded
        );

        // 模拟插件重新解析分享后送来的新直链
        apply_relink(&job, format!("http://{new_addr}/movie.bin"), None).expect("换链失败");

        let done = wait_done(&job).await;
        assert_eq!(done.state, "done", "换链后应能下完: {:?}", done.error);
        // 已完成的分片不重下 → 计数必须正好等于文件大小
        assert_eq!(done.downloaded, data.len() as u64, "换链后计数不该重复累加");
        assert_eq!(std::fs::read(&job.path).unwrap(), *data);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 直链一开始就不可用（探测就 403）时要立刻报错，而不是挂在那里等换链
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn 探测阶段直链不可用就立刻报错() {
        let data = Arc::new(pattern(1024 * 1024));
        let (addr, _served, expired) = spawn_quota_server(data, 0).await;
        expired.store(true, Ordering::Relaxed);
        let dir = temp_dir("probe-403");

        let err = match start_download(
            client(),
            format!("http://{addr}/x.bin"),
            vec![],
            dir.clone(),
            Some("x.bin".into()),
            4,
            true,
        )
        .await
        {
            Ok(_) => panic!("直链不可用时不该启动成功"),
            Err(e) => e,
        };
        assert!(
            err.contains("下载地址不可用"),
            "应报出直链不可用并提示重新解析: {err}"
        );
        assert!(
            err.contains("过期") || err.contains("HTTP 403"),
            "错误里要说明原因: {err}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    fn client() -> reqwest::Client {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .build()
            .unwrap()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn 分片下载拼装出完整文件() {
        // 8MB + 零头：分片数会被 MIN_CHUNK_BYTES 限制在 8
        let data = Arc::new(pattern(8 * 1024 * 1024 + 12345));
        let addr = spawn_server(data.clone(), true).await;
        let dir = temp_dir("multi");

        let job = start_download(
            client(),
            format!("http://{addr}/movie.bin"),
            vec![],
            dir.clone(),
            Some("movie.bin".into()),
            8,
            true,
        )
        .await
        .expect("启动下载失败");

        assert_eq!(job.connections, 8, "支持 Range 的大文件应开 8 个连接");
        let status = wait_done(&job).await;
        assert_eq!(status.state, "done", "下载失败: {:?}", status.error);
        assert_eq!(status.total, data.len() as u64);
        assert_eq!(status.downloaded, data.len() as u64);

        let got = std::fs::read(&job.path).unwrap();
        assert_eq!(got.len(), data.len());
        assert_eq!(got, *data, "分片写错偏移会导致内容不一致");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn 服务端不支持分片时退回单连接() {
        let data = Arc::new(pattern(3 * 1024 * 1024 + 7));
        let addr = spawn_server(data.clone(), false).await;
        let dir = temp_dir("single");

        let job = start_download(
            client(),
            format!("http://{addr}/plain.bin"),
            vec![],
            dir.clone(),
            Some("plain.bin".into()),
            16,
            true,
        )
        .await
        .expect("启动下载失败");

        assert_eq!(job.connections, 1, "不支持 Range 必须退回单连接");
        let status = wait_done(&job).await;
        assert_eq!(status.state, "done", "下载失败: {:?}", status.error);
        assert_eq!(std::fs::read(&job.path).unwrap(), *data);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn 片数远多于连接数时抢占取片仍然正确() {
        // 20MB / 4 连接 → 每片 1MB、共 20 片，4 个 worker 要来回抢 5 轮。
        // 抢片逻辑写错（重复下同一片 / 漏片）会让内容对不上或总量不足。
        let data = Arc::new(pattern(20 * 1024 * 1024 + 777));
        let addr = spawn_server(data.clone(), true).await;
        let dir = temp_dir("steal");

        let job = start_download(
            client(),
            format!("http://{addr}/big.bin"),
            vec![],
            dir.clone(),
            Some("big.bin".into()),
            4,
            true,
        )
        .await
        .expect("启动下载失败");

        assert_eq!(job.connections, 4);
        let (chunk_size, chunk_count) = plan_chunks(job.total, 4);
        assert!(
            chunk_count > 4,
            "本用例要的就是片数多于连接数，实得 {chunk_count} 片"
        );
        assert_eq!(chunk_size, MIN_CHUNK_BYTES);

        let status = wait_done(&job).await;
        assert_eq!(status.state, "done", "下载失败: {:?}", status.error);
        // 重复写同一片会让 downloaded 计数超过总长
        assert_eq!(
            status.downloaded,
            data.len() as u64,
            "计数与实际文件长度不一致，说明有分片被重复下载"
        );
        assert_eq!(std::fs::read(&job.path).unwrap(), *data);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn 取消后状态为_cancelled() {
        let data = Arc::new(pattern(2 * 1024 * 1024));
        let addr = spawn_server(data, true).await;
        let dir = temp_dir("cancel");

        let job = start_download(
            client(),
            format!("http://{addr}/x.bin"),
            vec![],
            dir.clone(),
            Some("x.bin".into()),
            4,
            true,
        )
        .await
        .expect("启动下载失败");

        job.cancel.store(true, Ordering::Relaxed);
        job.finish(State::Cancelled, None);
        let status = wait_done(&job).await;
        assert_eq!(status.state, "cancelled");
        assert_eq!(status.speed, 0);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn 直链失效时立刻报错而不是静默失败() {
        let data = Arc::new(pattern(1024));
        let addr = spawn_server(data, true).await;
        let dir = temp_dir("bad");

        // 服务端只回 200/206，这里用一个不存在的端口模拟连不上
        let err = match start_download(
            client(),
            "http://127.0.0.1:1/none.bin".to_string(),
            vec![],
            dir.clone(),
            Some("none.bin".into()),
            4,
            true,
        )
        .await
        {
            Ok(_) => panic!("连不上时不应返回成功"),
            Err(e) => e,
        };
        assert!(
            err.contains("探测失败") || err.contains("下载地址不可用"),
            "错误信息应可读且指向探测阶段: {err}"
        );

        let _ = addr;
        let _ = std::fs::remove_dir_all(&dir);
    }
}
