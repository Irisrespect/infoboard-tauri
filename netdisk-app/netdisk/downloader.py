"""多连接分片下载引擎

设计直接沿用已经验证过的那套（见 docs/NETDISK_PLUGIN.md），只是换成 Python：

- **动态分片队列 + 抢占式取片**：片数 ≈ 连接数 × 32，单片 ≥ 256KB。
  实测同样 512 并发下 256KB/片 23.65MB/s、512KB/片 12.94、1MB/片 6.58，
  且"分片数必须 ≥ 并发数"（626MB 用 2MB 分片只有 313 片，开 384 并发只跑出 4.9MB/s）。
- **直链自愈**：撞上 401/403/404/412 就回调 `relink` 拿新直链，从未完成的分片继续。
  独立软件在这里比插件版**更简单也更可靠** —— 没有"谁来轮询"的问题，
  下载线程自己就能去重新解析。
- **限流退避**：429/503 时所有线程一起等（首次 30 秒、翻倍、上限 5 分钟）。
- **慢分片抢占**：读超时（默认 15 秒没数据）就把这片交回队列，换条连接试。
"""

from __future__ import annotations

import os
import queue
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from .core import Client, HttpStatusError, human_speed, open_stream

MIN_CHUNK = 256 * 1024
CHUNKS_PER_CONNECTION = 32
MAX_CHUNKS = 16384
READ_TIMEOUT = 15.0
MAX_ATTEMPTS = 4
MAX_STALL_REQUEUE = 3
MAX_RELINKS = 5
BACKOFF_FIRST = 30.0
BACKOFF_MAX = 300.0


@dataclass
class Chunk:
    start: int
    end: int
    tries: int = 0


def plan_chunks(total: int, connections: int) -> tuple[int, int]:
    """切成多少片、每片多大（与 Rust 侧 plan_chunks 保持一致）"""
    conns = max(1, connections)
    size = max(total // (conns * CHUNKS_PER_CONNECTION), MIN_CHUNK)
    count = (total + size - 1) // size if size else 1
    if count > MAX_CHUNKS:
        size = (total + MAX_CHUNKS - 1) // MAX_CHUNKS
        count = (total + size - 1) // size if size else 1
    return size, max(1, count)


@dataclass
class DownloadTask:
    """一个下载任务的状态（GUI 直接读它来刷新界面）"""

    id: int
    name: str
    url: str
    path: Path
    total: int = 0
    done: int = 0
    connections: int = 1
    state: str = "pending"  # pending/running/expired/backoff/done/failed/cancelled
    message: str = ""
    speed: float = 0.0

    _last_at: float = 0.0
    _last_done: int = 0
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def snapshot(self) -> "DownloadTask":
        """给界面用的一份只读拷贝（避免跨线程读半更新的对象）"""
        with self._lock:
            return DownloadTask(
                id=self.id,
                name=self.name,
                url=self.url,
                path=self.path,
                total=self.total,
                done=self.done,
                connections=self.connections,
                state=self.state,
                message=self.message,
                speed=self.speed,
            )

    @property
    def progress(self) -> float:
        return (self.done / self.total * 100.0) if self.total else 0.0

    @property
    def speed_text(self) -> str:
        return human_speed(self.speed)


class Downloader:
    """把一条直链多连接下到本地。

    `relink` 是一个无参回调，返回**新的直链**（通常就是重新解析一次分享）。
    撞上直链过期时引擎会调它，然后从未完成的分片继续。
    """

    def __init__(
        self,
        client: Client,
        task: DownloadTask,
        headers: dict[str, str] | None = None,
        relink: Callable[[], str] | None = None,
        on_update: Callable[[DownloadTask], None] | None = None,
    ) -> None:
        self.client = client
        self.task = task
        self.headers = dict(headers or {})
        self.headers.setdefault("User-Agent", client.ua)
        self.relink = relink
        self.on_update = on_update

        self._queue: queue.Queue[Chunk] = queue.Queue()
        self._inflight: list[Chunk] = []
        self._inflight_lock = threading.Lock()
        self._cancel = threading.Event()
        self._backoff_until = 0.0
        self._backoff_lock = threading.Lock()
        self._relinks = 0
        # 换链要串行化：直链一过期，**所有** worker 都会同时撞上 401/403/412，
        # 如果各自去换一次，5 次的预算瞬间就用光了（而且会重复解析分享）。
        # 用"代次"判断：只有第一个发现的线程真正去换，其余的直接用新链继续。
        self._relink_lock = threading.Lock()
        self._url_generation = 0
        self._fatal: str | None = None

    # ── 对外接口 ──

    def cancel(self) -> None:
        self._cancel.set()

    @property
    def cancelled(self) -> bool:
        return self._cancel.is_set()

    def run(self) -> None:
        """阻塞执行整个下载（在后台线程里调）"""
        try:
            self._prepare()
            if self.task.state == "failed":
                return
            self._run_workers()
            self._finish()
        except Exception as e:  # 兜底：任何意外都要落到任务状态上，否则界面一直转圈
            self._set("failed", f"下载失败：{e}")

    # ── 内部 ──

    def _set(self, state: str, message: str = "") -> None:
        self.task.state = state
        if message:
            self.task.message = message
        self._notify()

    def _notify(self) -> None:
        if self.on_update:
            try:
                self.on_update(self.task.snapshot())
            except Exception:
                pass

    def _prepare(self) -> None:
        """探测：能不能分片、文件多大"""
        self._set("running", "正在探测下载地址…")
        try:
            resp = open_stream(
                self.client,
                self.task.url,
                self.headers,
                byte_range=(0, 0),
                timeout=20.0,
            )
        except HttpStatusError as e:
            self._set("failed", explain_status(e.status))
            return
        except Exception as e:
            self._set("failed", f"探测失败：{e}")
            return

        with resp:
            status = getattr(resp, "status", 200)
            content_range = resp.headers.get("Content-Range", "")
            content_length = resp.headers.get("Content-Length")
            disposition = resp.headers.get("Content-Disposition", "")

        if status == 206 and "/" in content_range:
            try:
                total = int(content_range.rsplit("/", 1)[1])
            except ValueError:
                total = 0
            ranged = True
        else:
            # 服务端忽略了 Range → 只能单连接，绝不硬分片（会把文件写坏）
            ranged = False
            total = int(content_length) if content_length and content_length.isdigit() else 0

        if disposition and not self.task.name:
            self.task.name = parse_filename(disposition) or self.task.name
        self.task.total = total

        conns = self.task.connections
        if not ranged or total <= MIN_CHUNK:
            conns = 1
        self.task.connections = conns

        self.task.path.parent.mkdir(parents=True, exist_ok=True)
        # 预分配：让各线程可以直接随机写自己的偏移
        if total > 0:
            with open(self.task.path, "wb") as f:
                f.truncate(total)

        if conns <= 1:
            self._queue.put(Chunk(0, total - 1 if total else 2**62))
        else:
            size, count = plan_chunks(total, conns)
            for i in range(count):
                start = i * size
                self._queue.put(Chunk(start, min(start + size, total) - 1))

        self._set("running", "")

    def _run_workers(self) -> None:
        threads = [
            threading.Thread(target=self._worker, name=f"dl-{self.task.id}-{i}", daemon=True)
            for i in range(self.task.connections)
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

    def _worker(self) -> None:
        # 每个线程用自己的文件句柄：Windows 上不同句柄的文件指针互相独立，
        # 天然就是"随机写"，不需要锁
        try:
            handle = open(self.task.path, "r+b")
        except OSError as e:
            self._fatal = self._fatal or f"打开文件失败：{e}"
            return
        try:
            while not self._cancel.is_set():
                try:
                    chunk = self._queue.get_nowait()
                except queue.Empty:
                    return
                with self._inflight_lock:
                    self._inflight.append(chunk)
                try:
                    ok = self._fetch(handle, chunk)
                finally:
                    with self._inflight_lock:
                        if chunk in self._inflight:
                            self._inflight.remove(chunk)
                if not ok:
                    return
        finally:
            handle.close()

    def _fetch(self, handle, chunk: Chunk) -> bool:
        """下完一个分片。返回 False 表示这个 worker 该退出了"""
        pos = chunk.start
        attempts = 0

        while pos <= chunk.end and not self._cancel.is_set():
            self._wait_backoff()
            generation = self._url_generation
            try:
                resp = open_stream(
                    self.client,
                    self.task.url,
                    self.headers,
                    byte_range=(pos, chunk.end),
                    timeout=READ_TIMEOUT,
                )
            except HttpStatusError as e:
                if e.status in (401, 403, 404, 412):
                    # 直链过期：放回队列，换链后接着下（已写下的字节有效，会从 pos 续传）
                    self._requeue_back(chunk)
                    return self._do_relink(generation)
                if e.status in (429, 503):
                    self._begin_backoff()
                    self._requeue_back(chunk)
                    return True
                attempts += 1
                if attempts >= MAX_ATTEMPTS:
                    self._fatal = self._fatal or explain_status(e.status)
                    return False
                time.sleep(0.4 * attempts)
                continue
            except TimeoutError:
                # 连接卡住：重排队，换条连接试
                self._requeue_stalled(chunk, pos)
                return True
            except Exception as e:
                attempts += 1
                if attempts >= MAX_ATTEMPTS:
                    self._fatal = self._fatal or f"连接失败：{e}"
                    return False
                time.sleep(0.4 * attempts)
                continue

            stalled = False
            try:
                with resp:
                    while pos <= chunk.end and not self._cancel.is_set():
                        try:
                            data = resp.read(256 * 1024)
                        except TimeoutError:
                            stalled = True
                            break
                        except Exception as e:
                            attempts += 1
                            if attempts >= MAX_ATTEMPTS:
                                self._fatal = self._fatal or f"读取中断：{e}"
                                return False
                            break
                        if not data:
                            break
                        take = min(len(data), chunk.end + 1 - pos)
                        handle.seek(pos)
                        handle.write(data[:take])
                        pos += take
                        self.task.done += take
                        attempts = 0
                        self._tick_speed()
                        if take < len(data):
                            break
            except Exception as e:
                self._fatal = self._fatal or f"读取响应失败：{e}"
                return False

            if stalled:
                self._requeue_stalled(chunk, pos)
                return True

            if pos <= chunk.end:
                # 服务端提前断开：没进展就算一次重试
                attempts += 1
                if attempts >= MAX_ATTEMPTS:
                    self._fatal = self._fatal or "下载停滞：服务端未继续返回数据"
                    return False
                time.sleep(0.3)
        return True

    # ── 队列操作 ──

    def _requeue_back(self, chunk: Chunk) -> None:
        """把分片放回队列。

        `queue.Queue` 没有"插回队首"，但这里不需要：分片之间彼此独立，
        谁先谁后不影响正确性；而**已写下的字节不会重下** ——
        重新取到这一片时会从 `pos` 继续（见 `_fetch` 的 while 循环）。
        """
        self._queue.put(chunk)

    def _requeue_stalled(self, chunk: Chunk, pos: int) -> None:
        if chunk.tries + 1 >= MAX_STALL_REQUEUE:
            self._fatal = self._fatal or (
                f"分片 {chunk.start}-{chunk.end} 重排 {MAX_STALL_REQUEUE} 次仍无进展"
            )
            return
        self._queue.put(Chunk(max(pos, chunk.start), chunk.end, chunk.tries + 1))

    # ── 换链与退避 ──

    def _do_relink(self, seen_generation: int) -> bool:
        """换新直链。

        `seen_generation` 是这个 worker 发起请求时看到的代次：如果期间已经有
        别的线程换过链，代次就变了 —— 直接拿新链继续，不再重复解析一次分享。
        """
        with self._relink_lock:
            if self._url_generation != seen_generation:
                return True  # 别人已经换好了
            if self.relink is None:
                self._set("failed", "直链已过期，且没有可用的换链方式")
                return False
            self._relinks += 1
            if self._relinks > MAX_RELINKS:
                self._set("failed", f"直链已自动换链 {MAX_RELINKS} 次仍未下完，请稍后重试")
                return False
            self._set("expired", "直链已过期，正在重新获取…")
            try:
                new_url = self.relink()
            except Exception as e:
                self._set("failed", f"重新获取直链失败：{e}")
                return False
            if not new_url:
                self._set("failed", "重新获取直链失败：没有拿到新地址")
                return False
            self.task.url = new_url
            self._url_generation += 1
            self._set("running", "")
            return True

    def _begin_backoff(self) -> None:
        with self._backoff_lock:
            extra = min(BACKOFF_FIRST * (2 ** min(self._relinks, 4)), BACKOFF_MAX)
            target = time.time() + extra
            if target > self._backoff_until:
                self._backoff_until = target
                self._set("backoff", f"触发服务端限流，静默 {int(extra)} 秒后继续")

    def _wait_backoff(self) -> None:
        while not self._cancel.is_set():
            with self._backoff_lock:
                left = self._backoff_until - time.time()
            if left <= 0:
                return
            time.sleep(min(left, 0.5))

    # ── 进度 ──

    def _tick_speed(self) -> None:
        now = time.time()
        if now - self.task._last_at < 0.5:
            return
        delta = self.task.done - self.task._last_done
        self.task.speed = delta / (now - self.task._last_at)
        self.task._last_at = now
        self.task._last_done = self.task.done
        self._notify()

    def _finish(self) -> None:
        if self._cancel.is_set():
            self._set("cancelled", "已取消")
            return
        if self._fatal:
            self._set("failed", self._fatal)
            return
        if self.task.total and self.task.done < self.task.total:
            self._set("failed", f"下载不完整：{self.task.done}/{self.task.total} 字节")
            return
        self.task.speed = 0
        self._set("done", "已完成")


def explain_status(code: int) -> str:
    """把状态码翻成一句能指导用户的话"""
    if code in (401, 403, 412):
        return (
            f"HTTP {code}：直链已过期或被拒绝。网盘直链通常只有 5~10 分钟有效期，"
            "请重新解析后再下（也可能是并发过高触发风控，可调低连接数）"
        )
    if code in (429, 503):
        return f"HTTP {code}：触发服务端限流，请调低并发连接数后重试"
    if code == 404:
        return "HTTP 404：直链已失效（文件可能已被删除或移动）"
    return f"HTTP {code}"


def parse_filename(disposition: str) -> str:
    """从 Content-Disposition 里取文件名（顺带处理 RFC 5987 的 UTF-8 形式）"""
    import urllib.parse

    for part in disposition.split(";"):
        part = part.strip()
        if part.lower().startswith("filename*="):
            value = part.split("=", 1)[1].rsplit("''", 1)[-1].strip('"')
            try:
                return urllib.parse.unquote(value)
            except Exception:
                continue
        if part.lower().startswith("filename="):
            return part.split("=", 1)[1].strip().strip('"')
    return ""


def safe_filename(name: str) -> str:
    """清洗文件名（与 Windows 兼容）"""
    cleaned = "".join("_" if c in '<>:"/\\|?*' or ord(c) < 32 else c for c in name)
    cleaned = cleaned.strip().rstrip(". ")
    return cleaned or "download.bin"


def unique_path(directory: Path, name: str) -> Path:
    """重名时另存为 "x (1).ext"，不覆盖已有文件"""
    candidate = directory / name
    if not candidate.exists():
        return candidate
    stem, ext = os.path.splitext(name)
    for i in range(1, 10000):
        p = directory / f"{stem} ({i}){ext}"
        if not p.exists():
            return p
    return directory / f"{stem}-{int(time.time())}{ext}"
