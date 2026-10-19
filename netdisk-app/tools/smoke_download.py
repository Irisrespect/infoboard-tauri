"""下载引擎冒烟测试（不需要网盘账号）

起一个本地 HTTP 服务真跑一遍分片下载，验证：
  1. 多连接分片拼装出的文件**逐字节正确**（偏移写错必然失败）
  2. 直链过期 → 换链 → 从未完成的分片继续（且计数不重复累加）
  3. 服务端不支持 Range 时退回单连接

这测的是引擎，不是网盘协议 —— 协议部分只有真账号能验。

用法：python tools/smoke_download.py
"""

from __future__ import annotations

import http.server
import socketserver
import sys
import tempfile
import threading
import time
from pathlib import Path

# 别在源码树里留 __pycache__（main.py 里同理）：自测工具不该污染仓库
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from netdisk.core import Client  # noqa: E402
from netdisk.downloader import DownloadTask, Downloader, plan_chunks  # noqa: E402


def safe_stdout() -> None:
    """Windows 控制台默认是 GBK，非 GBK 字符会让 print 抛 UnicodeEncodeError。

    回归：最后那行 `print("全部通过 ✅")` 在 GBK 控制台上**每次都抛**，
    于是"全部通过"反而变成退出码 1 —— 自测脚本自己把结论弄反了。
    所以这里既不使用 emoji，也把编码错误降级掉。
    """
    try:
        sys.stdout.reconfigure(errors="replace")  # type: ignore[union-attr]
    except Exception:
        pass


def pattern(n: int) -> bytes:
    """非对齐的字节模式：偏移写错必然对不上"""
    return bytes((i % 251) for i in range(n))


class RangeHandler(http.server.BaseHTTPRequestHandler):
    data = b""
    quota = 1 << 62          # 累计发够这么多字节后开始 403（模拟直链过期）
    served = 0
    expired = False
    support_range = True
    lock = threading.Lock()

    def log_message(self, *_a):  # 别刷屏
        pass

    def do_GET(self) -> None:  # noqa: N802
        cls = type(self)
        with cls.lock:
            if cls.expired:
                self.send_response(403)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return

        total = len(cls.data)
        start, end = 0, total - 1
        rng = self.headers.get("Range")
        if rng and cls.support_range:
            spec = rng.split("=", 1)[1]
            a, _, b = spec.partition("-")
            start = int(a) if a else 0
            end = int(b) if b else total - 1
        end = min(end, total - 1)
        use_range = bool(rng) and cls.support_range
        body = cls.data[start : end + 1] if use_range else cls.data

        self.send_response(206 if use_range else 200)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Accept-Ranges", "bytes" if cls.support_range else "none")
        if use_range:
            self.send_header("Content-Range", f"bytes {start}-{end}/{total}")
        self.end_headers()
        self.wfile.write(body)

        with cls.lock:
            cls.served += len(body)
            if cls.served >= cls.quota:
                cls.expired = True


def serve(data: bytes, quota: int = 1 << 62, support_range: bool = True):
    handler = type(
        "H", (RangeHandler,), {"data": data, "quota": quota, "served": 0, "expired": False,
                               "support_range": support_range, "lock": threading.Lock()}
    )
    httpd = socketserver.ThreadingTCPServer(("127.0.0.1", 0), handler)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, handler, f"http://127.0.0.1:{httpd.server_address[1]}/f.bin"


def run_task(url: str, dest: Path, name: str, conns: int, relink=None, timeout: float = 60.0):
    task = DownloadTask(id=1, name=name, url=url, path=dest / name, connections=conns)
    dl = Downloader(client=Client("test"), task=task, relink=relink)
    threading.Thread(target=dl.run, daemon=True).start()
    deadline = time.time() + timeout
    while task.state in ("pending", "running", "expired", "backoff") and time.time() < deadline:
        time.sleep(0.05)
    return task


def main() -> int:
    safe_stdout()
    failures = 0

    # ── 1) 多连接分片 ──
    data = pattern(8 * 1024 * 1024 + 555)
    httpd, handler, url = serve(data)
    with tempfile.TemporaryDirectory() as tmp:
        dest = Path(tmp)
        task = run_task(url, dest, "multi.bin", 8)
        got = (dest / "multi.bin").read_bytes() if (dest / "multi.bin").exists() else b""
        ok = task.state == "done" and got == data
        size, count = plan_chunks(len(data), 8)
        print(f"[1] 多连接分片：state={task.state} 片数={count}(每片{size}B) "
              f"写入={len(got)} 期望={len(data)} → {'OK' if ok else 'FAIL'}")
        failures += 0 if ok else 1
    httpd.shutdown()

    # ── 2) 直链过期 → 换链 → 断点续传 ──
    data2 = pattern(6 * 1024 * 1024 + 33)
    httpd2, handler2, url2 = serve(data2, quota=2 * 1024 * 1024)
    httpd3, handler3, url3 = serve(data2)  # “新直链”
    with tempfile.TemporaryDirectory() as tmp:
        dest = Path(tmp)
        relinks = {"n": 0}

        def relink() -> str:
            relinks["n"] += 1
            return url3

        task = run_task(url2, dest, "relink.bin", 4, relink=relink, timeout=90)
        got = (dest / "relink.bin").read_bytes() if (dest / "relink.bin").exists() else b""
        ok = task.state == "done" and got == data2 and task.done == len(data2)
        print(f"[2] 过期→换链→续传：state={task.state} 换链次数={relinks['n']} "
              f"计数={task.done} 期望={len(data2)} 一致={got == data2} → {'OK' if ok else 'FAIL'}")
        failures += 0 if ok else 1
    httpd2.shutdown()
    httpd3.shutdown()

    # ── 3) 不支持 Range → 单连接 ──
    data3 = pattern(1024 * 1024)
    httpd4, handler4, url4 = serve(data3, support_range=False)
    with tempfile.TemporaryDirectory() as tmp:
        dest = Path(tmp)
        task = run_task(url4, dest, "plain.bin", 16)
        got = (dest / "plain.bin").read_bytes() if (dest / "plain.bin").exists() else b""
        ok = task.state == "done" and got == data3 and task.connections == 1
        print(f"[3] 不支持 Range 退回单连接：state={task.state} 连接数={task.connections} "
              f"一致={got == data3} → {'OK' if ok else 'FAIL'}")
        failures += 0 if ok else 1
    httpd4.shutdown()

    print("\n全部通过" if failures == 0 else f"\n{failures} 项失败")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
