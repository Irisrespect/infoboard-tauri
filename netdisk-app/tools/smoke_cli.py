"""CLI 冒烟测试（不需要网盘账号，也不碰真实网络）

覆盖的是 `netdisk_cli.py` 自己那层逻辑 —— 适配器和下载引擎已被另外两个脚本验证过：

  1. 选择与过滤：`--index 1,3-5` 的解析、glob 匹配（相对路径 / 文件名两种）
  2. 进度板：非 tty 只打关键行、不打 ANSI 转义、按终端宽度裁剪
  3. 下载链路：`DownloadSession` 真跑一遍多连接分片 + 直链过期换链（本地 HTTP 服务）
  4. 列表渲染：序号（喂给 `--index` 的那个）与目录标记
  5. 命令行行为：`--help` 退出 0、认不出的链接退出 2、`config` 输出可解析的 JSON

用法：python tools/smoke_cli.py
"""

from __future__ import annotations

import io
import json
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

# 别在源码树里留 __pycache__
sys.dont_write_bytecode = True

HERE = Path(__file__).resolve().parent
APP = HERE.parent
sys.path.insert(0, str(APP))
sys.path.insert(0, str(HERE))

import netdisk_cli  # noqa: E402
from netdisk.core import Client, FileEntry, NetdiskError, ShareCtx  # noqa: E402
from smoke_download import pattern, serve  # noqa: E402

CLI = APP / "netdisk_cli.py"


def safe_stdout() -> None:
    """Windows 控制台默认 GBK，非 GBK 字符会让 print 抛错（见 smoke_download.py）"""
    try:
        sys.stdout.reconfigure(errors="replace")  # type: ignore[union-attr]
    except Exception:
        pass


def check(label: str, ok: bool, detail: str = "") -> int:
    print(f"[{label}] {'OK' if ok else 'FAIL'} {detail}")
    return 0 if ok else 1


# ── 1) 选择与过滤 ──


def test_selection() -> int:
    failures = 0
    failures += check(
        "1.1",
        netdisk_cli.parse_index_spec("1,3-5", 6) == [0, 2, 3, 4],
        str(netdisk_cli.parse_index_spec("1,3-5", 6)),
    )
    failures += check(
        "1.2",
        netdisk_cli.parse_index_spec("5,3-4,3", 5) == [2, 3, 4],
        str(netdisk_cli.parse_index_spec("5,3-4,3", 5)),
    )
    try:
        netdisk_cli.parse_index_spec("9", 3)
    except netdisk_cli.CliError:
        failures += check("1.3", True, "越界序号被拒")
    else:
        failures += check("1.3", False, "越界序号没被拒")

    entries = [
        (FileEntry(id="1", name="第1集.mp4", size=1), "课程/第1章"),
        (FileEntry(id="2", name="讲义.pdf", size=1), "课程/第1章"),
        (FileEntry(id="3", name="封面.JPG", size=1), ""),
    ]
    only = netdisk_cli.filter_files(entries, ["*.mp4"], [])
    failures += check("1.4", [e.name for e, _ in only] == ["第1集.mp4"], str([e.name for e, _ in only]))
    nested = netdisk_cli.filter_files(entries, ["课程/*"], [])
    failures += check(
        "1.5", [e.name for e, _ in nested] == ["第1集.mp4", "讲义.pdf"], str([e.name for e, _ in nested])
    )
    excluded = netdisk_cli.filter_files(entries, [], ["*.jpg"])
    failures += check("1.6", len(excluded) == 2, "排除不区分大小写")
    failures += check(
        "1.7",
        netdisk_cli._join_rel("课程/第1章", "") == "课程/第1章"
        and netdisk_cli._join_rel("a", "b/c") == "a/b/c",
        "相对路径拼接",
    )
    return failures


# ── 2) 进度板 ──


def test_board() -> int:
    failures = 0
    buf = io.StringIO()
    board = netdisk_cli.ProgressBoard(buf)
    board.update(1, "第一行")
    board.update(2, "第二行")
    board.line("一行日志")
    board.drop(1)
    board.drop(2)
    text = buf.getvalue()
    # 非 tty：不画进度板，也不该出现 ANSI 转义（否则重定向进日志就是乱码）
    failures += check("2.1", "第一行" not in text and "一行日志" in text, repr(text[:60]))
    failures += check("2.2", "\x1b[" not in text, "没有 ANSI 转义")

    board.tty = True
    board.width = 40
    board.update(1, "x" * 200)
    drawn = buf.getvalue().split("\n")[-2].replace("\x1b[2K", "")
    failures += check("2.3", len(drawn) <= 40 and drawn.endswith("…"), f"裁剪到 {len(drawn)} 字符")

    # tty：2 行 → 1 行时必须先上移 2 行、画新行、擦掉多余行，再把光标移回来。
    # 少一步就会在终端里堆出残影（或者越画越往下）。
    class Tty(io.StringIO):
        def isatty(self) -> bool:  # noqa: D401
            return True

    tty_buf = Tty()
    tty_board = netdisk_cli.ProgressBoard(tty_buf)
    tty_board.width = 60
    tty_board.update(1, "a")
    tty_board.update(2, "b")
    tty_board.drop(1)
    sequence = tty_buf.getvalue()
    failures += check(
        "2.4",
        sequence.endswith("\x1b[2A\x1b[2Kb\n\x1b[2K\n\x1b[1A") and "\x1b[1A\x1b[2Ka" in sequence,
        repr(sequence),
    )
    return failures


# ── 3) 下载链路（本地 HTTP） ──


class FakeAdapter:
    """只实现 CLI 用到的三个接口：client / resolve / invalidate"""

    name = "假网盘"
    root_id = "0"
    anonymous_hint = "未登录"
    parallel_expand = True

    def __init__(self, urls: list[str]) -> None:
        self.client = Client("fake")
        self._urls = urls
        self.resolve_calls = 0
        self.invalidated = 0

    def resolve(self, ctx, entry):
        self.resolve_calls += 1
        url = self._urls[min(self.resolve_calls - 1, len(self._urls) - 1)]
        return url, {}

    def invalidate(self, ctx, entry):
        self.invalidated += 1


def run_session(adapter: FakeAdapter, entry: FileEntry, dest: Path, connections: int):
    ctx = ShareCtx(adapter)
    opts = netdisk_cli.DownloadOptions(dest=dest, connections=connections, quiet=True)
    board = netdisk_cli.ProgressBoard(io.StringIO())
    session = netdisk_cli.DownloadSession(adapter, ctx, opts, board)
    return session, session.run([(entry, "")])


def test_download() -> int:
    failures = 0

    # 3.1 多连接分片：拼出来的文件必须逐字节正确
    data = pattern(3 * 1024 * 1024 + 777)
    httpd, _handler, url = serve(data)
    try:
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp)
            entry = FileEntry(id="f1", name="a.bin", size=len(data))
            _session, results = run_session(FakeAdapter([url]), entry, dest, 8)
            got = (dest / "a.bin").read_bytes() if (dest / "a.bin").exists() else b""
            result = results[0]
            failures += check(
                "3.1",
                result.state == "done" and got == data,
                f"state={result.state} 写入={len(got)} 期望={len(data)}",
            )
    finally:
        httpd.shutdown()

    # 3.2 直链过期 → 换链 → 从未完成的分片继续
    data2 = pattern(2 * 1024 * 1024 + 55)
    expired_server, _h2, bad_url = serve(data2, quota=512 * 1024)
    good_server, _h3, good_url = serve(data2)
    try:
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp)
            adapter = FakeAdapter([bad_url, good_url])
            entry = FileEntry(id="f2", name="b.bin", size=len(data2))
            _session, results = run_session(adapter, entry, dest, 4)
            got = (dest / "b.bin").read_bytes() if (dest / "b.bin").exists() else b""
            failures += check(
                "3.2",
                results[0].state == "done" and got == data2 and adapter.resolve_calls >= 2,
                f"state={results[0].state} 换链={adapter.resolve_calls} 一致={got == data2}",
            )
    finally:
        expired_server.shutdown()
        good_server.shutdown()

    # 3.3 单文件失败不该带走整批：坏链接 + 好链接一起下
    data3 = pattern(700 * 1024)
    httpd3, _h4, url3 = serve(data3)
    try:
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp)
            good = FileEntry(id="g", name="good.bin", size=len(data3))
            flat = [(FileEntry(id="bad", name="bad.bin", size=1), ""), (good, "")]
            adapter = FakeAdapter([url3])
            adapter.resolve = lambda ctx, entry: (  # type: ignore[assignment]
                ("http://127.0.0.1:1/nope" if entry.id == "bad" else url3),
                {},
            )
            ctx = ShareCtx(adapter)
            opts = netdisk_cli.DownloadOptions(dest=dest, connections=4, quiet=True)
            session = netdisk_cli.DownloadSession(adapter, ctx, opts, netdisk_cli.ProgressBoard(io.StringIO()))
            results = session.run(flat)
            states = {r.name: r.state for r in results}
            ok = (
                states.get("bad.bin") == "failed"
                and states.get("good.bin") == "done"
                and (dest / "good.bin").read_bytes() == data3
            )
            failures += check("3.3", ok, str(states))
    finally:
        httpd3.shutdown()
    return failures


# ── 4) 列表渲染 ──


def test_render() -> int:
    entries = [
        FileEntry(id="1", name="第1集", size=0, is_dir=True),
        FileEntry(id="2", name="a.mp4", size=1024 * 1024),
    ]
    buf = io.StringIO()
    netdisk_cli.render_listing(entries, buf)
    lines = buf.getvalue().strip().split("\n")
    ok = len(lines) == 2 and "1" in lines[0].split()[0] and "目录" in lines[0] and "1.0 MB" in lines[1]
    failures = check("4.1", ok, lines[0] if lines else "")
    nodes = [
        {"type": "dir", "name": "章", "children": [{"type": "file", "name": "a.mp4", "size": 1024}]},
    ]
    buf2 = io.StringIO()
    netdisk_cli.render_tree(nodes, buf2)
    text = buf2.getvalue()
    failures += check("4.2", "章/" in text and "  a.mp4" in text, text.replace("\n", "|"))
    return failures


# ── 5) 命令行行为 ──


def run_cli(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(CLI), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=180,
    )


def test_cli() -> int:
    failures = 0
    helped = run_cli("--help")
    failures += check("5.1", helped.returncode == 0 and "netdisk_cli.py" in helped.stdout, f"exit={helped.returncode}")

    bogus = run_cli("ls", "https://example.com/not-a-netdisk")
    failures += check(
        "5.2",
        bogus.returncode == 2 and "认不出" in bogus.stderr,
        f"exit={bogus.returncode}",
    )

    config = run_cli("config")
    parsed = None
    try:
        parsed = json.loads(config.stdout)
    except Exception:
        parsed = None
    failures += check(
        "5.3",
        config.returncode == 0 and isinstance(parsed, dict) and "dest_dir" in parsed,
        f"exit={config.returncode}",
    )
    failures += check(
        "5.4",
        isinstance(parsed, dict) and "__puus" not in config.stdout,
        "config 不回显 Cookie 原文",
    )

    no_cmd = run_cli()
    failures += check("5.5", no_cmd.returncode == 2, f"无子命令 exit={no_cmd.returncode}")
    return failures


# ── 6) 端到端：`get` 整个流程（假适配器 + 本地 HTTP，不碰网盘） ──


class FakeShareAdapter:
    """一棵假分享树 + 本地 HTTP 上的"直链"。

    换成真适配器只差三件事：真接口、真 cookie、真直链；CLI 那层（解析 → 进目录 →
    `--index/--only` → 展开 → 落盘路径 → 下载 → 汇总）走的完全是同一条路。
    """

    name = "假网盘"
    session = "fake"
    root_id = "0"
    anonymous_hint = "未登录"
    parallel_expand = True
    example_host = "fake.local"

    def __init__(self) -> None:
        self.client = Client("fake")
        self.urls: dict[str, str] = {}
        self.tree: dict[str, list[FileEntry]] = {}

    def configure(self, cfg) -> None:  # noqa: ANN001
        pass

    @property
    def logged_in(self) -> bool:
        return False

    def parse(self, url: str, pwd: str = ""):
        self.tree = {
            "0": [
                FileEntry(id="d-course", name="课程", is_dir=True),
                FileEntry(id="f-readme", name="说明.txt", size=5),
            ],
            "d-course": [
                FileEntry(id="d-ch1", name="第1章", is_dir=True),
                FileEntry(id="f-cover", name="封面.jpg", size=11),
            ],
            "d-ch1": [
                FileEntry(id="f-ep1", name="第1集.mp4", size=20),
                FileEntry(id="f-pdf", name="讲义.pdf", size=7),
            ],
        }
        return ShareCtx(self), list(self.tree["0"]), "假分享"

    def list_dir(self, ctx, dir_id: str = "0"):  # noqa: ANN001
        if dir_id not in self.tree:
            raise NetdiskError(f"没有这个目录：{dir_id}")
        return list(self.tree[dir_id])

    def resolve(self, ctx, entry):  # noqa: ANN001
        if entry.id not in self.urls:
            raise NetdiskError(f"{entry.name}：假适配器没有给直链")
        return self.urls[entry.id], {}

    def invalidate(self, ctx, entry) -> None:  # noqa: ANN001
        pass


class FakeConfig:
    def __init__(self) -> None:
        self.data = {
            "dest_dir": "",
            "connections": 4,
            "cookies": {},
            "max_depth": 32,
            "expand_workers": 2,
            "xunlei_cleanup": True,
            "xunlei_mirror": False,
        }

    def saved_cookies(self, session: str) -> str:
        return ""

    def set_cookies(self, session: str, raw: str) -> None:
        pass

    def save(self) -> None:
        pass


def run_get_cli(argv: list[str]) -> tuple[int, str]:
    """在进程内跑 `get`：替换掉 detect/Config，stdout 收进字符串。"""
    import contextlib

    original_detect = netdisk_cli.detect
    original_config = netdisk_cli.Config
    netdisk_cli.detect = lambda url: FakeShareAdapter  # type: ignore[assignment]
    netdisk_cli.Config = FakeConfig  # type: ignore[assignment]
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(io.StringIO()):
            code = netdisk_cli.main(argv)
    finally:
        netdisk_cli.detect = original_detect  # type: ignore[assignment]
        netdisk_cli.Config = original_config  # type: ignore[assignment]
    return code, buf.getvalue()


def test_end_to_end() -> int:
    failures = 0
    blobs = {
        "f-readme": b"hello",
        "f-cover": b"jpeg-bytes!",
        "f-ep1": pattern(900 * 1024),
        "f-pdf": b"%PDF-1."[:7],
    }
    servers = {}
    servers_urls = {}
    for key, blob in blobs.items():
        httpd, _handler, url = serve(blob)
        servers[key] = httpd
        servers_urls[key] = url

    original_init = FakeShareAdapter.__init__

    def patched_init(self) -> None:  # noqa: ANN001
        original_init(self)
        self.urls = dict(servers_urls)

    FakeShareAdapter.__init__ = patched_init  # type: ignore[assignment]

    try:
        url = "https://pan.quark.cn/s/fake"
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp)
            code, out = run_get_cli(
                ["get", url, "-o", str(dest), "--path", "课程", "--only", "*.mp4", "--json"]
            )
            payload = {}
            try:
                payload = json.loads(out)
            except Exception:
                payload = {}
            ep1 = dest / "课程" / "第1章" / "第1集.mp4"
            failures += check(
                "6.1",
                code == 0
                and payload.get("done") == 1
                and ep1.is_file()
                and ep1.read_bytes() == blobs["f-ep1"],
                f"exit={code} done={payload.get('done')} 落盘={ep1.is_file()}",
            )
            failures += check(
                "6.2",
                payload.get("files", [{}])[0].get("rel") == "课程/第1章",
                str(payload.get("files", [{}])[0].get("rel")),
            )
            failures += check(
                "6.3",
                not (dest / "课程" / "第1章" / "讲义.pdf").exists()
                and not (dest / "课程" / "封面.jpg").exists(),
                "只下了 *.mp4",
            )

        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp)
            code, out = run_get_cli(["get", url, "-o", str(dest), "--index", "2", "--json"])
            payload = {}
            try:
                payload = json.loads(out)
            except Exception:
                payload = {}
            readme = dest / "说明.txt"
            failures += check(
                "6.4",
                code == 0 and payload.get("done") == 1 and readme.read_bytes() == b"hello",
                f"exit={code} done={payload.get('done')}",
            )

        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp)
            code, out = run_get_cli(["get", url, "-o", str(dest)])
            failures += check("6.5", code == 0, f"整份分享 exit={code} {out.strip().splitlines()[-1] if out.strip() else ''}")
            expected = [
                dest / "说明.txt",
                dest / "课程" / "封面.jpg",
                dest / "课程" / "第1章" / "第1集.mp4",
                dest / "课程" / "第1章" / "讲义.pdf",
            ]
            failures += check("6.6", all(p.is_file() for p in expected), str([p.name for p in expected if not p.is_file()]))

        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp)
            code, _out = run_get_cli(["get", url, "-o", str(dest), "--dry-run"])
            failures += check(
                "6.7",
                code == 0 and not any(dest.rglob("*.*")),
                "--dry-run 不动磁盘",
            )

        code, out = run_get_cli(["get", url, "--index", "9"])
        failures += check("6.8", code == 2, f"越界序号 exit={code}")
    finally:
        for httpd in servers.values():
            httpd.shutdown()
    return failures


def main() -> int:
    safe_stdout()
    failures = 0
    failures += test_selection()
    failures += test_board()
    failures += test_download()
    failures += test_render()
    failures += test_cli()
    failures += test_end_to_end()
    print("\n全部通过" if failures == 0 else f"\n{failures} 项失败")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
