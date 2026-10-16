// ─── SMTC 媒体控制 ───
//
// 通过 PowerShell 子进程调用 Windows SMTC API。
// 复刻自 Electron 版 mediaControl.ts（已验证生产可用）。
// 每次调用启动独立的 PS 进程，结束后 COM 引用自动释放。
//   1. media_get_current_session()
//   2. media_send_command()

pub mod types;

use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use types::{MediaSession, ThumbnailCache};

// ─── 常量 ───

const QUERY_TIMEOUT_SECS: u64 = 12;
const COMMAND_TIMEOUT_SECS: u64 = 5;

// ─── PowerShell 辅助（复刻 Electron mediaControl.ts） ───

/// 已验证的 PS_AWAIT_HELPER（原始项目生产可用）
/// 注意：`IAsyncOperation`1` 只需一个反引号！
const PS_AWAIT_HELPER: &str = r#"
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($WinRtTask, $ResultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
}
"#;

/// 合并查询脚本：SMTC + 窗口标题（复刻 Electron queryCombined + BiliWinEnum2）
const PS_QUERY_COMBINED: &str = r#"
# C# 内联：枚举 B站窗口标题
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;

public class BiliWinEnum2 {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern int GetWindowTextLength(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    public static string GetVideoTitle() {
        var titles = new List<string>();
        var pids = new HashSet<uint>();
        foreach (var proc in System.Diagnostics.Process.GetProcesses()) {
            try {
                var name = proc.ProcessName.ToLower();
                if (name.Contains("bilibili") || name.Contains("哔哩哔哩")) pids.Add((uint)proc.Id);
            } catch {}
        }
        if (pids.Count == 0) return "";
        EnumWindows((hWnd, lParam) => {
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            if (!pids.Contains(pid)) return true;
            if (!IsWindowVisible(hWnd)) return true;
            int len = GetWindowTextLength(hWnd);
            if (len <= 0) return true;
            var sb = new StringBuilder(len + 1);
            GetWindowText(hWnd, sb, sb.Capacity);
            titles.Add(sb.ToString());
            return true;
        }, IntPtr.Zero);
        if (titles.Count == 0) return "";
        string best = null;
        foreach (var t in titles) {
            if (t.Contains("干杯~") || t == "哔哩哔哩" || t == "bilibili") continue;
            if (t == "MSCTFIME UI" || t == "Default IME") continue;
            if (best == null || t.Length > best.Length) best = t;
        }
        return best ?? "";
    }
}
"@

$sessionManagerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
try {
    $manager = Await ($sessionManagerType::RequestAsync()) $sessionManagerType
    $session = $manager.GetCurrentSession()

    $appId = ""
    $status = ""
    $smtcTitle = ""
    $smtcArtist = ""
    $smtcThumbnail = ""

    if ($session -ne $null) {
        $playbackInfo = $session.GetPlaybackInfo()
        $appId = $session.SourceAppUserModelId
        $status = $playbackInfo.PlaybackStatus.ToString()

        try {
            $mediaProperties = Await ($session.TryGetMediaPropertiesAsync()) ([System.Object])
            if ($mediaProperties -ne $null) {
                $smtcTitle = [string]$mediaProperties.Title
                $smtcArtist = [string]$mediaProperties.Artist

                try {
                    $thumbRef = $mediaProperties.Thumbnail
                    if ($thumbRef -ne $null) {
                        $stream = Await ($thumbRef.OpenReadAsync()) ([System.Object])
                        if ($stream -ne $null -and $stream.Size -gt 0 -and $stream.Size -lt 524288) {
                            $ms = New-Object System.IO.MemoryStream
                            $stream.AsStreamForRead().CopyTo($ms)
                            $bytes = $ms.ToArray()
                            if ($bytes.Length -gt 0) {
                                $smtcThumbnail = [Convert]::ToBase64String($bytes)
                            }
                            $ms.Close()
                        }
                        $stream.Dispose()
                    }
                } catch {}
            }
        } catch {}
    }

    $windowTitle = [BiliWinEnum2]::GetVideoTitle()

    @{ appId=$appId; status=$status; smtcTitle=$smtcTitle; smtcArtist=$smtcArtist; smtcThumbnail=$smtcThumbnail; windowTitle=$windowTitle } | ConvertTo-Json -Compress
} catch {
    Write-Output "{""error"":""$($_.Exception.Message)""}"
}
"#;

/// 发送控制命令脚本（复刻 Electron sendMediaCommand）
const PS_SEND_COMMAND: &str = r#"
$sessionManagerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
try {
    $manager = Await ($sessionManagerType::RequestAsync()) $sessionManagerType
    $session = $manager.GetCurrentSession()

    if ($session -eq $null) {
        Write-Output "NO_SESSION"
        exit
    }

    $result = Await ($session.{method}()) ([System.Boolean])
    Write-Output "OK:$result"
} catch {
    Write-Output "ERROR: $($_.Exception.Message)"
}
"#;

// ─── 状态管理 ───

pub struct AppState {
    pub thumbnail_cache: Mutex<Option<ThumbnailCache>>,
    /// 是否已有查询在途。前端每 2 秒轮询一次，而"启动 powershell.exe + COM 查询"
    /// 经常慢于 2 秒，没有这个标志就会不断堆积 PowerShell 进程。
    query_in_flight: AtomicBool,
    /// 上一次查询结果，在途期间直接复用它（避免前端状态闪断）
    session_cache: Mutex<Option<MediaSession>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            thumbnail_cache: Mutex::new(None),
            query_in_flight: AtomicBool::new(false),
            session_cache: Mutex::new(None),
        }
    }

    /// 缓存的会话（锁中毒时按"无会话"处理，不让一次 panic 永久卡死轮询）
    fn cached_session(&self) -> Option<MediaSession> {
        self.session_cache.lock().ok().and_then(|c| c.clone())
    }

    fn store_session(&self, session: &Option<MediaSession>) {
        if let Ok(mut cache) = self.session_cache.lock() {
            *cache = session.clone();
        }
    }
}

/// RAII：无论查询成功、失败还是提前 return，都保证清掉"在途"标志
struct InFlightGuard<'a>(&'a AtomicBool);

impl Drop for InFlightGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

// ─── PowerShell 执行器 ───

fn run_powershell(script: &str, timeout_secs: u64) -> Result<String, String> {
    let mut cmd = Command::new("powershell.exe");
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-WindowStyle",
        "Hidden",
        "-Command",
        script,
    ]);
    // 隐藏 PowerShell 控制台窗口（release 打包后不弹出黑框）
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        // _ = 忽略 error（仅影响隐藏效果，不影响命令执行）
        let _ = &mut cmd;
        unsafe {
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
    }
    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("启动 PowerShell 失败: {e}"))?;

    // 子进程运行期间就必须持续排空 stdout/stderr，否则输出超过管道缓冲（约 4 KB）
    // 后子进程会阻塞在写入上，永远不退出
    fn drain<R: std::io::Read + Send + 'static>(
        pipe: Option<R>,
    ) -> Option<std::thread::JoinHandle<Vec<u8>>> {
        pipe.map(|mut r| {
            std::thread::spawn(move || {
                let mut buf = Vec::new();
                let _ = r.read_to_end(&mut buf);
                buf
            })
        })
    }
    let stdout_reader = drain(child.stdout.take());
    let stderr_reader = drain(child.stderr.take());

    let start = std::time::Instant::now();
    let timeout = Duration::from_secs(timeout_secs);

    loop {
        match child.try_wait() {
            Ok(Some(_status)) => {
                let out = stdout_reader
                    .ok_or("无法读取输出")?
                    .join()
                    .map_err(|_| "读取输出失败: 线程异常".to_string())?;
                if let Some(h) = stderr_reader {
                    let _ = h.join();
                }
                return Ok(String::from_utf8_lossy(&out).trim().to_string());
            }
            Ok(None) => {
                if start.elapsed() > timeout {
                    // 不 join 读取线程：kill 后管道随之关闭，线程会自行结束
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("PowerShell 超时".to_string());
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(format!("等待 PowerShell 失败: {e}")),
        }
    }
}

// ─── Tauri Commands ───

#[tauri::command]
pub async fn media_get_current_session(
    state: tauri::State<'_, AppState>,
) -> Result<Option<MediaSession>, String> {
    // 高频轮询，不写日志台以免刷屏
    // 防堆积：已有查询在途时直接返回上一次的结果，不再新起一个 powershell.exe
    if state.query_in_flight.swap(true, Ordering::SeqCst) {
        return Ok(state.cached_session());
    }
    let _guard = InFlightGuard(&state.query_in_flight);

    // 拼接 helper + 查询脚本
    let script = format!("{PS_AWAIT_HELPER}\n{PS_QUERY_COMBINED}");

    let output = tokio::task::spawn_blocking(move || {
        run_powershell(&script, QUERY_TIMEOUT_SECS)
    })
    .await
    .map_err(|e| format!("spawn_blocking 失败: {e}"))?
    .map_err(|e| {
        eprintln!("[media_get_current_session] {e}");
        "PowerShell 查询失败".to_string()
    })?;

    // 解析 JSON。注意：输出里带缩略图 base64（约 700 KB），只打印长度不打印内容
    let json: serde_json::Value = match serde_json::from_str(&output) {
        Ok(v) => v,
        Err(e) => {
            eprintln!(
                "[media_get_current_session] JSON 解析失败: {e}（输出 {} 字节）",
                output.len()
            );
            state.store_session(&None);
            return Ok(None);
        }
    };

    // 检查错误
    if json.get("error").and_then(|v| v.as_str()).map(|s| !s.is_empty()).unwrap_or(false) {
        eprintln!("[media_get_current_session] PS 错误: {}", json["error"]);
        state.store_session(&None);
        return Ok(None);
    }

    // 检查状态（原始项目逻辑：状态为空 → 无会话）
    let status = json["status"].as_str().unwrap_or("");
    if status.is_empty() {
        state.store_session(&None);
        return Ok(None);
    }

    let app_id = json["appId"].as_str().unwrap_or("").to_string();
    let mut smtc_title = json["smtcTitle"].as_str().unwrap_or("").to_string();
    let smtc_artist = json["smtcArtist"].as_str().unwrap_or("").to_string();
    let window_title = json["windowTitle"].as_str().unwrap_or("").to_string();

    // SMTC 标题为空时，用窗口标题兜底（B站 UWP 的 SMTC 不设置 Title）
    if smtc_title.is_empty() && !window_title.is_empty() {
        // 从 "视频标题 — UP主 — 哔哩哔哩" 格式提取
        if let Some((title, _artist)) = parse_window_title(&window_title) {
            smtc_title = title;
        }
    }

    // 窗口标题也空 → 无活跃视频
    if smtc_title.is_empty() || smtc_title == "哔哩哔哩" {
        state.store_session(&None);
        return Ok(None);
    }

    let raw_thumb = json["smtcThumbnail"].as_str().unwrap_or("").to_string();

    let thumbnail = if raw_thumb.is_empty() {
        String::new()
    } else {
        format!("data:image/jpeg;base64,{raw_thumb}")
    };

    // 缩略图缓存
    let mut cache = state.thumbnail_cache.lock().map_err(|e| format!("锁失败: {e}"))?;
    let (thumbnail_data, thumbnail_mime) = if let Some(ref c) = *cache {
        if c.title == smtc_title {
            (c.data.clone(), c.mime_prefix.clone())
        } else {
            let (mime, data) = split_thumbnail_data(&thumbnail);
            *cache = Some(ThumbnailCache {
                title: smtc_title.clone(),
                data,
                mime_prefix: mime.clone(),
            });
            cache.as_ref().map(|c| (c.data.clone(), c.mime_prefix.clone())).unwrap_or_default()
        }
    } else {
        let (mime, data) = split_thumbnail_data(&thumbnail);
        *cache = Some(ThumbnailCache { title: smtc_title.clone(), data, mime_prefix: mime.clone() });
        cache.as_ref().map(|c| (c.data.clone(), c.mime_prefix.clone())).unwrap_or_default()
    };
    let final_thumb = if thumbnail_data.is_empty() { String::new() } else { format!("{thumbnail_mime}{thumbnail_data}") };

    // 标准化播放状态
    let playback_status = normalize_status(status);

    let session = Some(MediaSession {
        title: smtc_title,
        artist: smtc_artist,
        thumbnail: final_thumb,
        playback_status,
        source_app_id: app_id,
    });
    state.store_session(&session);
    Ok(session)
}

/// 发送播放控制命令
#[tauri::command]
pub async fn media_send_command(command: String) -> Result<bool, String> {
    // 映射命令到 SMTC 方法名（复刻 Electron 做法）
    let method = match command.as_str() {
        "play" => "TryPlayAsync",
        "pause" => "TryPauseAsync",
        "toggle" => "TryTogglePlayPauseAsync",
        "next" => "TrySkipNextAsync",
        "previous" => "TrySkipPreviousAsync",
        _ => return Err(format!("未知命令: {command}")),
    };

    let script = format!("{PS_AWAIT_HELPER}\n{}", PS_SEND_COMMAND.replace("{method}", method));

    let output = tokio::task::spawn_blocking(move || {
        run_powershell(&script, COMMAND_TIMEOUT_SECS)
    })
    .await
    .map_err(|e| format!("spawn_blocking 失败: {e}"))?
    .unwrap_or_else(|e| {
        eprintln!("[media_send_command] {e}");
        String::new()
    });

    Ok(output.starts_with("OK:true"))
}

// ─── 工具函数 ───

fn normalize_status(s: &str) -> String {
    match s.to_lowercase().as_str() {
        "playing" => "playing".to_string(),
        "paused" => "paused".to_string(),
        "stopped" => "stopped".to_string(),
        _ => "closed".to_string(),
    }
}

/// 从窗口标题提取视频标题（复刻 Electron parseWindowTitle）
/// "视频标题 — UP主 — 哔哩哔哩" → 标题 + UP主
fn parse_window_title(window_title: &str) -> Option<(String, String)> {
    let cleaned = window_title
        .replace(" —哔哩哔哩", "")
        .replace(" —哔哩哔哩", "")
        .replace(" -哔哩哔哩", "")
        .replace(" - bilibili", "")
        .replace(" - 哔哩哔哩", "")
        .trim()
        .to_string();

    if cleaned.is_empty() || cleaned == "哔哩哔哩" || cleaned == "bilibili" || cleaned.contains("干杯~") {
        return None;
    }

    let parts: Vec<&str> = cleaned.split(&['—', '-'][..]).collect();
    if parts.len() >= 2 {
        let artist = parts.last().map(|s| s.trim().to_string()).unwrap_or_default();
        let title = parts[..parts.len() - 1].join(" - ").trim().to_string();
        if !title.is_empty() && !artist.is_empty() && artist.len() < 20 {
            return Some((title, artist));
        }
    }

    Some((cleaned, String::new()))
}

fn split_thumbnail_data(uri: &str) -> (String, String) {
    if let Some(pos) = uri.find("base64,") {
        let prefix = uri[..pos + 7].to_string();
        let data = uri[pos + 7..].to_string();
        (prefix, data)
    } else {
        ("data:image/jpeg;base64,".to_string(), uri.to_string())
    }
}

// ─── 单元测试 ───

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_status() {
        assert_eq!(normalize_status("Playing"), "playing");
        assert_eq!(normalize_status("Paused"), "paused");
        assert_eq!(normalize_status("Stopped"), "stopped");
        assert_eq!(normalize_status("Closed"), "closed");
        assert_eq!(normalize_status(""), "closed");
    }

    #[test]
    fn test_parse_window_title() {
        // 窗口标题已由 C# 代码清洗过，不含后缀
        let r = parse_window_title("测试视频 — UP主");
        assert!(r.is_some());
        let (t, a) = r.unwrap();
        assert_eq!(t, "测试视频");
        assert_eq!(a, "UP主");
    }

    #[test]
    fn test_parse_window_title_no_match() {
        assert!(parse_window_title("哔哩哔哩 (゜-゜)つロ 干杯~").is_none());
    }

    #[test]
    fn test_split_thumbnail_data() {
        let uri = "data:image/png;base64,ABC123";
        let (prefix, data) = split_thumbnail_data(uri);
        assert_eq!(prefix, "data:image/png;base64,");
        assert_eq!(data, "ABC123");
    }

    /// 回归：输出远超管道缓冲（~4 KB）时不应死锁
    #[cfg(windows)]
    #[test]
    fn test_run_powershell_large_output_no_deadlock() {
        let out = run_powershell("[Console]::Out.Write('a' * 200000)", 20).expect("应成功返回");
        assert_eq!(out.len(), 200000);
    }

    #[test]
    fn test_split_thumbnail_data_no_prefix() {
        let uri = "ABC123";
        let (prefix, data) = split_thumbnail_data(uri);
        assert_eq!(prefix, "data:image/jpeg;base64,");
        assert_eq!(data, "ABC123");
    }
}
