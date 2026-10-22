"""B 站下载器 —— 独立软件入口（Tkinter 界面）

为什么做成独立软件而不是只留在 InfoBoard 里：
- 插件跑在 WebView 里：不能发网络请求（CSP 只放通 api.bilibili.com，且 B 站接口
  对带异源 Origin 的请求直接 403）、不能写文件、不能启动进程；
- 按钮点一下就想下载完，只能把「下载」这一步交给本机进程。

所以这里是一个自包含的小程序：粘链接 → 选画质 → 开始下载。
真正的下载交给本机 yt-dlp（没有就点「安装 yt-dlp」，脚本会自动 pip 安装）。

只用标准库（tkinter + subprocess），不需要 pip 装任何界面依赖。
"""

from __future__ import annotations

import json
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

sys.dont_write_bytecode = True

import tkinter as tk  # noqa: E402

APP_NAME = "B 站下载器"
APP_DIR = Path(os.environ.get("APPDATA") or Path.home()) / "bili-dl-app"
CONFIG_PATH = APP_DIR / "config.json"

QUALITIES = [
    ("best", "最高画质"),
    ("2160", "4K (2160P)"),
    ("1080", "1080P"),
    ("720", "720P"),
    ("480", "480P"),
    ("audio-m4a", "仅音频 m4a"),
    ("audio-mp3", "仅音频 mp3"),
]
CODECS = [("auto", "编码自动"), ("h264", "H.264"), ("hevc", "HEVC"), ("av1", "AV1")]
BROWSERS = [
    ("none", "不带登录态"),
    ("vivaldi", "Vivaldi"),
    ("chrome", "Chrome"),
    ("edge", "Edge"),
    ("firefox", "Firefox"),
]

CREATE_NO_WINDOW = 0x08000000
PROGRESS_RE = re.compile(r"\[download\]\s+(\d{1,3}(?:\.\d+)?)%")
SPEED_RE = re.compile(r"\bat\s+([\d.]+\s*[KMG]?i?B/s)", re.I)
ETA_RE = re.compile(r"\bETA\s+(\d+:\d+(?::\d+)?)", re.I)


def decode_line(raw: bytes) -> str:
    """按 UTF-8 解，失败退回 GBK。

    yt-dlp 往管道里写的是 `sys.stdout.encoding` —— Windows 上默认还是 cp936，
    一律按 UTF-8 解就会得到 `�����ǻ���` 这种乱码。子进程那边我们已经用
    PYTHONUTF8/PYTHONIOENCODING 强制 UTF-8，这里再兜一层编码回退。
    """
    for enc in ("utf-8", "gbk"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")

# B 站 App「分享」出来的是这种一段话：【标题】https://...【标题】https://...
# 直接把这整段丢给 yt-dlp 会得到 "not a valid URL"，所以先抠链接。
URL_RE = re.compile(r"https?://[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+")
BV_RE = re.compile(r"BV[0-9A-Za-z]{10}")
AV_RE = re.compile(r"\bav(\d{1,12})\b", re.I)
EP_RE = re.compile(r"\bep(\d{1,10})\b", re.I)
SS_RE = re.compile(r"\bss(\d{1,10})\b", re.I)
CLEAN_CUT = " \t\r\n<>()[]{}（）【】，。、；：\"'“”‘’"

# 分享链接里的跟踪参数，去掉后再去重才能认出"同一条视频"
TRACKING_PARAMS = {
    "vd_source",
    "spm_id_from",
    "share_source",
    "share_medium",
    "share_plat",
    "share_session_id",
    "share_tag",
    "share_times",
    "from_source",
    "from_spmid",
    "unique_k",
    "bbdown_client",
    "buvid",
    "up_id",
    "timestamp",
    "ts",
    "source",
    "is_story_h5",
    "launch_id",
}


# ─────────────────────────── 配置 ───────────────────────────

DEFAULT_CONFIG = {
    "quality": "1080",
    "codec": "auto",
    "browser": "none",
    "pages": "",
    "outdir": str(Path.home() / "Downloads" / "Bilibili"),
    "cookies_file": "",
}


def load_config() -> dict:
    cfg = dict(DEFAULT_CONFIG)
    try:
        raw = CONFIG_PATH.read_text(encoding="utf-8")
        saved = json.loads(raw)
        if isinstance(saved, dict):
            cfg.update({k: v for k, v in saved.items() if k in DEFAULT_CONFIG})
    except (OSError, ValueError):
        pass
    return cfg


def save_config(cfg: dict) -> None:
    try:
        APP_DIR.mkdir(parents=True, exist_ok=True)
        CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError:
        pass


# ─────────────────────────── yt-dlp ───────────────────────────


def find_ytdlp() -> list[str] | None:
    """返回启动 yt-dlp 的命令前缀：优先独立可执行文件，其次 python -m yt_dlp。"""
    exe = shutil.which("yt-dlp") or shutil.which("yt-dlp.exe")
    if exe:
        return [exe]
    for candidate in (sys.executable, shutil.which("python"), shutil.which("py")):
        if not candidate:
            continue
        try:
            done = subprocess.run(
                [candidate, "-m", "yt_dlp", "--version"],
                capture_output=True,
                text=True,
                timeout=20,
                creationflags=CREATE_NO_WINDOW,
            )
            if done.returncode == 0:
                return [candidate, "-m", "yt_dlp"]
        except (OSError, subprocess.SubprocessError):
            continue
    return None


def build_args(cfg: dict, url: str) -> list[str]:
    args: list[str] = ["--newline", "--windows-filenames"]
    outdir = str(cfg.get("outdir") or "").strip()
    if outdir:
        args += ["-P", outdir]
    args += ["-o", "%(title)s [%(id)s].%(ext)s"]

    quality = cfg.get("quality", "1080")
    if quality == "audio-m4a":
        args += ["-f", "ba[ext=m4a]/ba"]
    elif quality == "audio-mp3":
        args += ["-f", "ba", "-x", "--audio-format", "mp3", "--audio-quality", "0"]
    else:
        cap = "" if quality == "best" else f"[height<={quality}]"
        args += ["-f", f"bv*{cap}+ba/b{cap}", "--merge-output-format", "mp4"]
        codec = {"h264": "vcodec:h264", "hevc": "vcodec:hev1", "av1": "vcodec:av01"}.get(
            cfg.get("codec", "auto")
        )
        if codec:
            args += ["-S", codec]

    browser = cfg.get("browser", "none")
    if browser and browser != "none":
        args += ["--cookies-from-browser", browser]
    # cookies.txt 是"浏览器锁着数据库"时的逃生通道（Vivaldi/Chrome 运行时会独占该文件）
    cookies_file = str(cfg.get("cookies_file") or "").strip()
    if cookies_file and Path(cookies_file).is_file():
        args += ["--cookies", cookies_file]
    pages = str(cfg.get("pages") or "").strip()
    if pages:
        args += ["-I", pages]
    args.append(url)
    return args


def clean_url(url: str) -> str | None:
    """去掉分享链接里的跟踪参数，统一成 https://www.bilibili.com/video/BVxxx[?p=N]"""
    from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

    url = url.strip().strip(CLEAN_CUT)
    if not url.lower().startswith(("http://", "https://")):
        return None
    try:
        parts = urlsplit(url)
    except ValueError:
        return None
    if not parts.netloc:
        return None
    query = [
        (k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if k.lower() not in TRACKING_PARAMS
    ]
    scheme = "https" if parts.scheme.lower() == "http" else parts.scheme.lower()
    return urlunsplit((scheme, parts.netloc.lower(), parts.path, urlencode(query), ""))


def extract_targets(text: str) -> list[str]:
    """从一段文字里抠出视频地址。

    支持三种输入：
      1. 完整链接（可以混在分享文案里，如【标题】https://...）
      2. 裸 BV / av / ep / ss 号
      3. 上面两种重复粘贴多次 —— 会去重
    """
    found: list[str] = []
    seen: set[str] = set()

    def push(url: str | None) -> None:
        if url and url not in seen:
            seen.add(url)
            found.append(url)

    for match in URL_RE.finditer(text):
        push(clean_url(match.group(0)))

    if found:
        return found

    if bv := BV_RE.search(text):
        push(f"https://www.bilibili.com/video/{bv.group(0)}")
    elif m := AV_RE.search(text):
        push(f"https://www.bilibili.com/video/av{m.group(1)}")
    elif m := EP_RE.search(text):
        push(f"https://www.bilibili.com/bangumi/play/ep{m.group(1)}")
    elif m := SS_RE.search(text):
        push(f"https://www.bilibili.com/bangumi/play/ss{m.group(1)}")
    return found


# ─────────────────────────── 界面 ───────────────────────────


class App:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.cfg = load_config()
        self.events: queue.Queue[tuple[str, str]] = queue.Queue()
        self.worker: threading.Thread | None = None
        self.proc: subprocess.Popen | None = None
        self.stop_requested = False

        root.title(APP_NAME)
        root.geometry("780x640")
        root.minsize(680, 560)

        self._build_ui()
        self._load_into_widgets()
        self.root.after(120, self._drain_events)
        self.root.protocol("WM_DELETE_WINDOW", self._on_close)
        self.root.after(300, self._check_tools)

    # ── 布局 ──
    def _build_ui(self) -> None:
        pad = {"padx": 12, "pady": 6}

        top = ttk.LabelFrame(self.root, text="链接（每行一条，或点「粘贴」）")
        top.pack(fill="x", **pad)

        self.url_text = tk.Text(top, height=4, wrap="none", font=("Consolas", 10))
        self.url_text.pack(side="left", fill="both", expand=True, padx=(8, 4), pady=8)

        btns = ttk.Frame(top)
        btns.pack(side="right", fill="y", padx=(0, 8), pady=8)
        ttk.Button(btns, text="粘贴", width=9, command=self._paste).pack(pady=2)
        ttk.Button(btns, text="清空", width=9, command=lambda: self.url_text.delete("1.0", "end")).pack(
            pady=2
        )

        opts = ttk.LabelFrame(self.root, text="下载选项")
        opts.pack(fill="x", **pad)

        row1 = ttk.Frame(opts)
        row1.pack(fill="x", padx=8, pady=(8, 4))
        ttk.Label(row1, text="画质").pack(side="left")
        self.quality = ttk.Combobox(row1, state="readonly", width=14, values=[n for _, n in QUALITIES])
        self.quality.pack(side="left", padx=(6, 16))
        ttk.Label(row1, text="编码").pack(side="left")
        self.codec = ttk.Combobox(row1, state="readonly", width=10, values=[n for _, n in CODECS])
        self.codec.pack(side="left", padx=(6, 16))
        ttk.Label(row1, text="登录态").pack(side="left")
        self.browser = ttk.Combobox(
            row1, state="readonly", width=10, values=[n for _, n in BROWSERS]
        )
        self.browser.pack(side="left", padx=(6, 0))

        row2 = ttk.Frame(opts)
        row2.pack(fill="x", padx=8, pady=4)
        ttk.Label(row2, text="分P（空=全部）").pack(side="left")
        self.pages = ttk.Entry(row2, width=12)
        self.pages.pack(side="left", padx=(6, 16))

        row3 = ttk.Frame(opts)
        row3.pack(fill="x", padx=8, pady=(4, 4))
        ttk.Label(row3, text="保存到").pack(side="left")
        self.outdir = ttk.Entry(row3)
        self.outdir.pack(side="left", fill="x", expand=True, padx=6)
        ttk.Button(row3, text="选择…", width=8, command=self._pick_dir).pack(side="left")

        row4 = ttk.Frame(opts)
        row4.pack(fill="x", padx=8, pady=(0, 10))
        ttk.Label(row4, text="cookies.txt").pack(side="left")
        self.cookies = ttk.Entry(row4)
        self.cookies.pack(side="left", fill="x", expand=True, padx=6)
        ttk.Button(row4, text="浏览…", width=8, command=self._pick_cookies).pack(side="left")
        ttk.Button(row4, text="清除", width=6, command=self._clear_cookies).pack(side="left", padx=4)

        actions = ttk.Frame(self.root)
        actions.pack(fill="x", **pad)
        self.start_btn = ttk.Button(actions, text="开始下载", command=self._start)
        self.start_btn.pack(side="left")
        self.stop_btn = ttk.Button(actions, text="停止", command=self._stop, state="disabled")
        self.stop_btn.pack(side="left", padx=8)
        ttk.Button(actions, text="打开下载目录", command=self._open_dir).pack(side="left")
        ttk.Button(actions, text="安装 yt-dlp", command=self._install_ytdlp).pack(side="right")

        prog_row = ttk.Frame(self.root)
        prog_row.pack(fill="x", padx=12, pady=(0, 4))
        self.progress = ttk.Progressbar(prog_row, mode="determinate", maximum=100)
        self.progress.pack(side="left", fill="x", expand=True)
        # 速率/ETA 单独放右边：进度条只管百分比，速度每秒都在跳，混在状态栏里读不清
        self.speed = ttk.Label(prog_row, text="", width=24, anchor="e")
        self.speed.pack(side="left", padx=(8, 0))

        log_frame = ttk.LabelFrame(self.root, text="日志")
        log_frame.pack(fill="both", expand=True, **pad)
        self.log = tk.Text(log_frame, height=12, wrap="word", state="disabled", font=("Consolas", 9))
        scroll = ttk.Scrollbar(log_frame, command=self.log.yview)
        self.log.configure(yscrollcommand=scroll.set)
        scroll.pack(side="right", fill="y")
        self.log.pack(side="left", fill="both", expand=True, padx=6, pady=6)

        self.status = ttk.Label(self.root, text="就绪", anchor="w")
        self.status.pack(fill="x", padx=14, pady=(0, 8))

    def _load_into_widgets(self) -> None:
        def index(options: list[tuple[str, str]], value: str) -> int:
            for i, (key, _) in enumerate(options):
                if key == value:
                    return i
            return 0

        self.quality.current(index(QUALITIES, self.cfg["quality"]))
        self.codec.current(index(CODECS, self.cfg["codec"]))
        self.browser.current(index(BROWSERS, self.cfg["browser"]))
        self.pages.insert(0, self.cfg["pages"])
        self.outdir.insert(0, self.cfg["outdir"])
        self.cookies.insert(0, self.cfg.get("cookies_file", ""))

    # ── 小动作 ──
    def _paste(self) -> None:
        try:
            text = self.root.clipboard_get()
        except tk.TclError:
            return
        self.url_text.insert("end", text.strip() + "\n")

    def _pick_dir(self) -> None:
        chosen = filedialog.askdirectory(initialdir=self.outdir.get() or str(Path.home()))
        if chosen:
            self.outdir.delete(0, "end")
            self.outdir.insert(0, chosen)

    def _pick_cookies(self) -> None:
        chosen = filedialog.askopenfilename(
            title="选择 cookies.txt（Netscape 格式）",
            filetypes=[("Cookies 文本", "*.txt"), ("所有文件", "*.*")],
        )
        if chosen:
            self.cookies.delete(0, "end")
            self.cookies.insert(0, chosen)

    def _clear_cookies(self) -> None:
        self.cookies.delete(0, "end")

    def _open_dir(self) -> None:
        target = self.outdir.get().strip()
        if not target:
            return
        Path(target).mkdir(parents=True, exist_ok=True)
        os.startfile(target)  # type: ignore[attr-defined]

    def _write_log(self, line: str) -> None:
        self.log.configure(state="normal")
        self.log.insert("end", line + "\n")
        self.log.see("end")
        self.log.configure(state="disabled")

    def _set_status(self, text: str) -> None:
        self.status.configure(text=text)

    def _collect_settings(self) -> dict:
        cfg = {
            "quality": QUALITIES[self.quality.current()][0],
            "codec": CODECS[self.codec.current()][0],
            "browser": BROWSERS[self.browser.current()][0],
            "pages": self.pages.get().strip(),
            "outdir": self.outdir.get().strip(),
            "cookies_file": self.cookies.get().strip(),
        }
        save_config(cfg)
        return cfg

    def _check_tools(self) -> None:
        if find_ytdlp() is None:
            self._write_log("⚠ 没找到 yt-dlp：点右上角「安装 yt-dlp」即可（会用 pip 安装）。")
        elif shutil.which("ffmpeg") is None:
            self._write_log("⚠ 没找到 ffmpeg：合并音视频 / 转 mp3 会失败，其余画质不受影响。")

    # ── 下载 ──
    def _start(self) -> None:
        lines = [line for line in self.url_text.get("1.0", "end").splitlines() if line.strip()]

        urls: list[str] = []
        skipped: list[str] = []
        for line in lines:
            got = extract_targets(line)
            if not got:
                skipped.append(line.strip())
                continue
            for url in got:
                if url not in urls:
                    urls.append(url)

        if not urls:
            messagebox.showinfo(
                APP_NAME,
                "没识别出链接。直接粘 BV 号（BV1xx411c7mD）或视频地址就行，\n分享文案里带【标题】也能认。",
            )
            return
        if find_ytdlp() is None:
            messagebox.showwarning(APP_NAME, "还没装 yt-dlp，点「安装 yt-dlp」")
            return

        self._write_log(f"识别到 {len(urls)} 条链接")
        if skipped:
            preview = " / ".join(s[:40] for s in skipped[:3])
            self._write_log(f"⚠ 跳过 {len(skipped)} 行（没识别出链接）：{preview}")

        cfg = self._collect_settings()
        self.stop_requested = False
        self.start_btn.configure(state="disabled")
        self.stop_btn.configure(state="normal")
        self.progress.configure(value=0)
        self.speed.configure(text="")

        self.worker = threading.Thread(target=self._run_all, args=(cfg, urls), daemon=True)
        self.worker.start()

    def _run_all(self, cfg: dict, urls: list[str]) -> None:
        prefix = find_ytdlp()
        if prefix is None:
            self.events.put(("done", "没找到 yt-dlp"))
            return

        total = len(urls)
        for i, url in enumerate(urls, start=1):
            if self.stop_requested:
                break
            self.events.put(("log", f"\n===== [{i}/{total}] {url} ====="))
            self.events.put(("status", f"下载中 {i}/{total}"))
            code = self._run_one(prefix, cfg, url)
            if code != 0 and not self.stop_requested:
                self.events.put(("log", f"✗ 失败（exit {code}）"))
                self.events.put(
                    (
                        "log",
                        "  常见原因：1080P+/番剧需要登录态；Chrome/Edge 新版 Cookie 受 ABE 保护"
                        "（可换 Firefox，或用扩展导出 cookies.txt）；合并音视频需要 ffmpeg",
                    )
                )

        self.events.put(("done", "已停止" if self.stop_requested else "全部完成"))

    def _run_one(self, prefix: list[str], cfg: dict, url: str) -> int:
        code, cookie_issue = self._spawn(prefix, cfg, url)

        # 两种"带浏览器反而失败"的典型情况：
        #   copy    —— Chromium 系浏览器运行时会独占 Cookies 数据库（Vivaldi/Chrome/Edge 都会），
        #              yt-dlp 连复制都做不到（yt-dlp#7271）
        #   decrypt —— Chrome 127+/Edge 用 App-Bound Encryption，能复制但解不开（yt-dlp#10927）
        # 两种都不该让整次下载白跑：不登录也能拿 480P~1080P，先降级重试一次。
        if code != 0 and not self.stop_requested and cookie_issue:
            self.events.put(("log", ""))
            if cookie_issue == "copy":
                hint = (
                    "⚠ 浏览器还开着，Cookies 数据库被独占，读不出来。已自动改为「不带登录态」重试；"
                    "要下 1080P60 / 大会员画质，请先**完全退出**浏览器（Vivaldi 含后台进程）再点开始。"
                )
            else:
                hint = (
                    "⚠ 浏览器 Cookie 解不开（Chrome/Edge 新版的 ABE 加密）。已自动改为「不带登录态」重试；"
                    "要登录态请换 Firefox，或用扩展导出 cookies.txt 填到上面那一栏。"
                )
            self.events.put(("log", hint))
            retry_cfg = dict(cfg)
            retry_cfg["browser"] = "none"
            code, _ = self._spawn(prefix, retry_cfg, url)
        return code

    def _spawn(self, prefix: list[str], cfg: dict, url: str) -> tuple[int, str | None]:
        """跑一次 yt-dlp，返回 (退出码, Cookie 问题类型: copy / decrypt / None)"""
        cmd = prefix + build_args(cfg, url)
        self.events.put(("log", "$ " + " ".join(cmd)))
        cookie_issue: str | None = None
        try:
            self.proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                bufsize=0,
                creationflags=CREATE_NO_WINDOW,
                # 子进程是 Python 写的（pip 装的 yt-dlp）：强制它用 UTF-8 输出，
                # 否则中文标题/日志会按系统代码页（cp936）吐出来
                env={**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"},
            )
        except OSError as exc:
            self.events.put(("log", f"启动失败：{exc}"))
            return 1, None

        assert self.proc.stdout is not None
        for raw in self.proc.stdout:
            line = decode_line(raw).replace("\r", "").rstrip()
            if not line:
                continue
            lower = line.lower()
            if "could not copy" in lower and "cookie" in lower:
                cookie_issue = "copy"
            elif "failed to decrypt" in lower or ("cookie" in lower and "error" in lower):
                cookie_issue = cookie_issue or "decrypt"
            match = PROGRESS_RE.search(line)
            if match:
                extra = []
                if speed := SPEED_RE.search(line):
                    extra.append(speed.group(1))
                if eta := ETA_RE.search(line):
                    extra.append(f"ETA {eta.group(1)}")
                # 刚起步时 yt-dlp 会打印 "at Unknown B/s ETA Unknown"，别让速度栏空着
                detail = " · ".join(extra) if extra else "连接中…"
                self.events.put(("progress", f"{match.group(1)}|{detail}"))
            else:
                self.events.put(("log", line))
            if self.stop_requested and self.proc.poll() is None:
                self.proc.terminate()
        code = self.proc.wait()
        self.proc = None
        return code, cookie_issue

    def _stop(self) -> None:
        self.stop_requested = True
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
        self._set_status("正在停止…")

    def _install_ytdlp(self) -> None:
        python = sys.executable

        def work() -> None:
            self.events.put(("log", "$ pip install -U yt-dlp"))
            try:
                proc = subprocess.Popen(
                    [python, "-m", "pip", "install", "-U", "yt-dlp"],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    creationflags=CREATE_NO_WINDOW,
                )
                assert proc.stdout is not None
                for line in proc.stdout:
                    if line.strip():
                        self.events.put(("log", line.rstrip()))
                code = proc.wait()
            except OSError as exc:
                self.events.put(("log", f"安装失败：{exc}"))
                return
            self.events.put(("log", "安装成功" if code == 0 else f"安装失败（exit {code}）"))

        threading.Thread(target=work, daemon=True).start()

    # ── 事件泵 ──
    def _drain_events(self) -> None:
        try:
            while True:
                kind, payload = self.events.get_nowait()
                if kind == "log":
                    self._write_log(payload)
                elif kind == "progress":
                    # payload = "45.3|1.23MiB/s · ETA 00:08"
                    pct, _, detail = payload.partition("|")
                    self.progress.configure(value=float(pct))
                    self.speed.configure(text=detail)
                    self._set_status(f"下载中… {pct}%")
                elif kind == "status":
                    self._set_status(payload)
                elif kind == "done":
                    self._set_status(payload)
                    self.progress.configure(value=0)
                    self.speed.configure(text="")
                    self.start_btn.configure(state="normal")
                    self.stop_btn.configure(state="disabled")
        except queue.Empty:
            pass
        self.root.after(120, self._drain_events)

    def _on_close(self) -> None:
        if self.worker and self.worker.is_alive():
            if not messagebox.askyesno(APP_NAME, "还在下载，确定退出？"):
                return
            self.stop_requested = True
            if self.proc and self.proc.poll() is None:
                self.proc.terminate()
        self.root.destroy()


def main() -> None:
    try:  # 高分屏下别糊
        import ctypes

        ctypes.windll.shcore.SetProcessDpiAwareness(1)  # type: ignore[attr-defined]
    except Exception:
        pass

    root = tk.Tk()
    try:
        ttk.Style().theme_use("vista")
    except tk.TclError:
        pass
    App(root)
    root.mainloop()


if __name__ == "__main__":
    main()
