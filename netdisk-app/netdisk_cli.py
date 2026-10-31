r"""网盘下载器 —— 命令行版

和 GUI（`main.py`）共用同一套 `netdisk/` 适配器与下载引擎，只是把"点鼠标"换成参数：

    netdisk_cli.py ls     <链接>          列目录（默认分享根目录）
    netdisk_cli.py tree   <链接>          打印整棵树（用来找 --path / --index）
    netdisk_cli.py get    <链接>          下载（默认整份分享）
    netdisk_cli.py login  quark|xunlei|status
    netdisk_cli.py config               看/改保存目录、并发等

常用的几条：

    # 整份分享下到默认目录（%USERPROFILE%\Downloads\网盘下载）
    python netdisk_cli.py get "https://pan.quark.cn/s/xxxx"

    # 只下第 1、3、5 项，8 个连接，放到 D:\片
    python netdisk_cli.py get "https://pan.quark.cn/s/xxxx" --index 1,3,5 -o D:\片 -c 8

    # 先看有什么，再按扩展名挑
    python netdisk_cli.py ls "https://pan.quark.cn/s/xxxx"
    python netdisk_cli.py get "https://pan.quark.cn/s/xxxx" --only "*.mp4"

    # 进子目录、整目录递归下（深层目录自动加 \\?\ 前缀，不会卡在 MAX_PATH）
    python netdisk_cli.py get "https://pan.quark.cn/s/xxxx" --path "课程/第1章" -o D:\课程

    # 夸克登录（浏览器复制 Cookie 直接管道进来）、迅雷扫码、看状态
    Get-Clipboard | python netdisk_cli.py login quark
    python netdisk_cli.py login xunlei
    python netdisk_cli.py login status

为什么是 CLI 而不是再写一套：协议、目录展开、多连接分片、直链自愈、限流退避
全在 `netdisk/` 里，CLI 只负责"参数 → 选条目 → 起任务 → 画进度"。GUI 与 CLI
共用同一个 `config.json`（见 `netdisk/config.py`），所以登录态互通。

退出码：0 全部成功 / 1 有文件失败 / 2 用法或配置错误（解析失败、认不出链接等）
/ 130 用户中断（Ctrl+C）。
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import shutil
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

# 别在源码树里留 __pycache__（与 main.py 一致：安装到只读目录时写字节码会失败）
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))

from netdisk import xunlei  # noqa: E402
from netdisk.adapters import QuarkAdapter  # noqa: E402
from netdisk.config import Config, default_dest_dir  # noqa: E402
from netdisk.core import (  # noqa: E402
    FileEntry,
    NetdiskError,
    ShareCtx,
    ensure_dir,
    human_size,
)
from netdisk.downloader import (  # noqa: E402
    DownloadTask,
    Downloader,
    safe_filename,
    unique_path,
)
from netdisk.services import detect, host_lines, service_names  # noqa: E402
from netdisk.tree import (  # noqa: E402
    DEFAULT_MAX_DEPTH,
    DEFAULT_WORKERS,
    MAX_DEPTH_LIMIT,
    MAX_WORKERS,
    clamp_depth,
    clamp_workers,
    flatten,
)

STATE_TEXT = {
    "pending": "等待中",
    "running": "下载中",
    "expired": "换链中",
    "backoff": "限流退避",
    "done": "完成",
    "failed": "失败",
    "cancelled": "已取消",
}

EXIT_OK = 0
EXIT_PARTIAL = 1
EXIT_USAGE = 2
EXIT_INTERRUPT = 130


class CliError(Exception):
    """面向用户的错误：消息直接打到 stderr，退出码 2"""


# ---------------------------------------------------------------------------
# 输出
# ---------------------------------------------------------------------------


def safe_stdout() -> None:
    """输出编码：控制台跟随系统（中文 Windows 是 GBK），管道统一 UTF-8。

    两个坑：
    1) `print("✓")` 在 GBK 控制台上直接抛 UnicodeEncodeError，把跑完的结果毁掉 ——
       所以始终把编码错误降级成替换字符。
    2) `--json` / 重定向是给脚本吃的，脚本一般按 UTF-8 读；按 GBK 写出去就是乱码。
       所以非 tty 的流改成 UTF-8（只改编码，不影响控制台上的中文显示）。
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            if _is_tty(stream):
                stream.reconfigure(errors="replace")  # type: ignore[union-attr]
            else:
                stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
        except Exception:
            pass


def _is_tty(stream: Any) -> bool:
    try:
        return bool(stream.isatty())
    except Exception:
        return False


def _clip(text: str, width: int) -> str:
    return text if len(text) <= width else text[: max(0, width - 1)] + "…"


def _bar(percent: float, width: int = 18) -> str:
    percent = max(0.0, min(100.0, percent))
    filled = int(percent / 100 * width)
    return "[" + "#" * filled + "-" * (width - filled) + "]"


class ProgressBoard:
    """多任务进度板：tty 上原地重绘 N 行，管道/重定向里只留关键行。

    逐行清屏用的是 ANSI：`\\x1b[{n}A` 上移 n 行，`\\x1b[2K` 清整行。
    Windows 10+ 的 conhost / Windows Terminal 都认；不支持的老终端本来也不是 tty
    （重定向到文件时 tty=False），所以不会打出乱码转义序列。
    """

    def __init__(self, stream: Any = None) -> None:
        self.stream = stream or sys.stdout
        self.tty = _is_tty(self.stream)
        columns = shutil.get_terminal_size((100, 24)).columns
        self.width = max(60, columns - 1)
        self._rows: dict[int, str] = {}
        self._drawn = 0
        self._lock = threading.Lock()

    def update(self, key: int, text: str) -> None:
        if not self.tty:
            return
        with self._lock:
            self._rows[key] = text
            self._draw()

    def drop(self, key: int) -> None:
        if not self.tty:
            return
        with self._lock:
            self._rows.pop(key, None)
            self._draw()

    def line(self, text: str) -> None:
        """在进度板之外打一行（先把板子擦掉，写完再画回来）"""
        with self._lock:
            if not self.tty:
                self.stream.write(text + "\n")
                self.stream.flush()
                return
            if self._drawn:
                self.stream.write(f"\x1b[{self._drawn}A")
                self.stream.write("".join("\x1b[2K\n" for _ in range(self._drawn)))
                self.stream.write(f"\x1b[{self._drawn}A")
                self._drawn = 0
            self.stream.write(_clip(text, self.width) + "\n")
            self.stream.flush()
            if self._rows:
                self._draw()

    def _draw(self) -> None:
        rows = [self._rows[k] for k in sorted(self._rows)]
        buf: list[str] = []
        if self._drawn:
            buf.append(f"\x1b[{self._drawn}A")
        for row in rows:
            buf.append("\x1b[2K" + _clip(row, self.width) + "\n")
        if len(rows) < self._drawn:
            # 行数变少：把下面多出来的擦掉，再把光标移回去，下一轮仍从第一行开始
            extra = self._drawn - len(rows)
            buf.append("".join("\x1b[2K\n" for _ in range(extra)))
            buf.append(f"\x1b[{extra}A")
        self.stream.write("".join(buf))
        self.stream.flush()
        self._drawn = len(rows)


# ---------------------------------------------------------------------------
# 链接 → 适配器
# ---------------------------------------------------------------------------


def open_adapter(url: str, cfg: Config) -> tuple[Any, type]:
    """认链接、造适配器、灌配置和已保存的登录态。"""
    cls = detect(url)
    if cls is None:
        supported = "\n".join(f"  · {line}" for line in host_lines())
        raise CliError(f"认不出这是哪家网盘的链接。目前支持：\n{supported}")
    adapter = cls()
    adapter.configure(cfg.data)
    saved = cfg.saved_cookies(getattr(cls, "session", ""))
    if saved and hasattr(adapter.client, "import_cookies"):
        adapter.client.import_cookies(saved)
    return adapter, cls


def parse_share(adapter: Any, url: str, pwd: str) -> tuple[ShareCtx, list[FileEntry], str]:
    try:
        return adapter.parse(url, pwd)
    except NetdiskError:
        raise
    except Exception as e:  # 适配器以外的意外也要给人话
        raise CliError(f"解析失败：{type(e).__name__}: {e}") from e


# ---------------------------------------------------------------------------
# 目录导航与选择
# ---------------------------------------------------------------------------


def _find_dir(entries: list[FileEntry], segment: str) -> FileEntry:
    for entry in entries:
        if entry.is_dir and entry.name == segment:
            return entry
    lowered = segment.lower()
    for entry in entries:
        if entry.is_dir and entry.name.lower() == lowered:
            return entry
    names = "、".join(e.name for e in entries if e.is_dir) or "（没有子目录）"
    raise CliError(f"在分享里找不到目录「{segment}」。这一层的目录有：{names}")


def list_path(
    adapter: Any, ctx: ShareCtx, root_entries: list[FileEntry], path_spec: str
) -> tuple[list[FileEntry], list[str]]:
    """按 `a/b/c` 逐层进目录，返回 `(这一层的条目, 走过的目录名列表)`。"""
    entries = list(root_entries)
    walked: list[str] = []
    for segment in [s for s in (path_spec or "").replace("\\", "/").split("/") if s]:
        target = _find_dir(entries, segment)
        try:
            entries = adapter.list_dir(ctx, target.id)
        except NetdiskError:
            raise
        except Exception as e:
            raise CliError(f"列目录失败（{segment}）：{e}") from e
        walked.append(target.name)
    return entries, walked


def parse_index_spec(spec: str, count: int) -> list[int]:
    """`1,3-5` → [0, 2, 3, 4]（转成 0 基下标，并按 count 校验）"""
    picked: list[int] = []
    for piece in str(spec or "").replace("，", ",").split(","):
        piece = piece.strip()
        if not piece:
            continue
        if "-" in piece:
            left, _, right = piece.partition("-")
            try:
                a, b = int(left), int(right)
            except ValueError as e:
                raise CliError(f"看不懂的序号范围：{piece}（应形如 3-5）") from e
            if a > b:
                a, b = b, a
            picked.extend(range(a, b + 1))
        else:
            try:
                picked.append(int(piece))
            except ValueError as e:
                raise CliError(f"看不懂的序号：{piece}（应形如 3 或 3-5）") from e
    bad = [i for i in picked if i < 1 or i > count]
    if bad:
        raise CliError(f"序号超出范围：{bad}（这一层只有 {count} 项，序号从 1 开始）")
    return sorted({i - 1 for i in picked})


def match_any(path: str, patterns: list[str]) -> bool:
    """glob 匹配。带 `/` 的模式匹配相对路径，不带的只匹配文件名。"""
    name = path.rsplit("/", 1)[-1].lower()
    for pattern in patterns:
        pat = pattern.strip().lower()
        if not pat:
            continue
        target = path.lower() if "/" in pat else name
        if fnmatch.fnmatchcase(target, pat):
            return True
    return False


def filter_files(
    flat: list[tuple[FileEntry, str]], includes: list[str], excludes: list[str]
) -> list[tuple[FileEntry, str]]:
    out: list[tuple[FileEntry, str]] = []
    for entry, rel in flat:
        full = f"{rel}/{entry.name}" if rel else entry.name
        if includes and not match_any(full, includes):
            continue
        if excludes and match_any(full, excludes):
            continue
        out.append((entry, rel))
    return out


# ---------------------------------------------------------------------------
# 下载
# ---------------------------------------------------------------------------


@dataclass
class DownloadOptions:
    dest: Path
    connections: int
    jobs: int = 1
    overwrite: bool = False
    quiet: bool = False


@dataclass
class JobResult:
    name: str
    rel: str
    path: str
    size: int = 0
    state: str = "pending"
    message: str = ""
    seconds: float = 0.0

    def as_json(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "rel": self.rel,
            "path": self.path,
            "size": self.size,
            "state": self.state,
            "message": self.message,
            "seconds": round(self.seconds, 2),
        }


def _row_text(idx: int, count: int, task: DownloadTask) -> str:
    label = f"[{idx}/{count}]"
    name = _clip(task.name, 34)
    percent = task.progress
    parts = [f"{label:>10}", f"{name:<34}", _bar(percent), f"{percent:5.1f}%"]
    if task.total:
        parts.append(f"{human_size(task.done)}/{human_size(task.total)}")
    parts.append(f"{task.speed_text:>10}")
    if task.state in ("expired", "backoff"):
        parts.append(STATE_TEXT.get(task.state, task.state))
    return " ".join(parts).rstrip()


class DownloadSession:
    """一组文件的下载（`jobs` 个文件并行，每个文件自己再开 `connections` 条连接）。"""

    def __init__(self, adapter: Any, ctx: ShareCtx, opts: DownloadOptions, board: ProgressBoard):
        self.adapter = adapter
        self.ctx = ctx
        self.opts = opts
        self.board = board
        self.cancel_event = threading.Event()
        self._live: dict[int, Downloader] = {}
        self._live_lock = threading.Lock()

    def cancel(self) -> None:
        self.cancel_event.set()
        with self._live_lock:
            downloaders = list(self._live.values())
        for dl in downloaders:
            dl.cancel()

    def run(self, flat: list[tuple[FileEntry, str]]) -> list[JobResult]:
        count = len(flat)
        results: list[JobResult | None] = [None] * count
        cursor = {"next": 0}
        cursor_lock = threading.Lock()

        def take() -> int | None:
            with cursor_lock:
                if cursor["next"] >= count:
                    return None
                index = cursor["next"]
                cursor["next"] += 1
                return index

        def worker() -> None:
            while True:
                index = take()
                if index is None:
                    return
                entry, rel = flat[index]
                if self.cancel_event.is_set():
                    results[index] = JobResult(
                        name=entry.name, rel=rel, path="", size=entry.size, state="cancelled"
                    )
                    continue
                try:
                    results[index] = self._one(index + 1, count, entry, rel)
                except NetdiskError as e:
                    results[index] = self._failed(index + 1, count, entry, rel, str(e))
                except Exception as e:  # noqa: BLE001 —— 单文件意外不该带走整批
                    results[index] = self._failed(
                        index + 1, count, entry, rel, f"{type(e).__name__}: {e}"
                    )

        threads = [
            threading.Thread(target=worker, name=f"netdisk-cli-{i}", daemon=True)
            for i in range(max(1, min(self.opts.jobs, count)))
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            while thread.is_alive():
                thread.join(0.2)
        return [r for r in results if r is not None]

    # ── 单个文件 ──

    def _one(self, idx: int, count: int, entry: FileEntry, rel: str) -> JobResult:
        started = time.time()
        display = f"{rel}/{entry.name}" if rel else entry.name
        if not self.board.tty and not self.opts.quiet:
            self.board.line(f"[{idx}/{count}] 开始 {display}（{entry.size_text}）")

        url, headers = self.adapter.resolve(self.ctx, entry)

        dest_dir = self.opts.dest / rel if rel else self.opts.dest
        ensure_dir(dest_dir)
        name = safe_filename(entry.name or f"file-{entry.id}")
        path = dest_dir / name if self.opts.overwrite else unique_path(dest_dir, name)

        task = DownloadTask(
            id=idx,
            name=path.name,
            url=url,
            path=path,
            connections=self.opts.connections,
        )
        if self.board.tty and not self.opts.quiet:
            self.board.update(idx, _row_text(idx, count, task))

        def relink() -> str:
            """直链过期：让适配器重新取一次（迅雷要先丢掉缓存那条）。"""
            invalidate = getattr(self.adapter, "invalidate", None)
            if invalidate is not None:
                invalidate(self.ctx, entry)
            new_url, _headers = self.adapter.resolve(self.ctx, entry)
            return new_url

        downloader = Downloader(
            client=self.adapter.client,
            task=task,
            headers=headers,
            relink=relink,
            on_update=lambda t: self.board.update(idx, _row_text(idx, count, t)),
        )
        with self._live_lock:
            self._live[idx] = downloader
        try:
            downloader.run()          # 阻塞，直到完成 / 失败 / 取消
        finally:
            with self._live_lock:
                self._live.pop(idx, None)
            self.board.drop(idx)

        result = JobResult(
            name=task.name,
            rel=rel,
            path=str(path),
            size=entry.size,
            state=task.state,
            message=task.message,
            seconds=time.time() - started,
        )
        if not self.opts.quiet:
            if task.state == "done":
                self.board.line(f"[{idx}/{count}] 完成 {display} → {path}")
            else:
                self.board.line(f"[{idx}/{count}] 失败 {display}：{task.message}")
        return result

    def _failed(self, idx: int, count: int, entry: FileEntry, rel: str, message: str) -> JobResult:
        display = f"{rel}/{entry.name}" if rel else entry.name
        self.board.drop(idx)
        if not self.opts.quiet:
            self.board.line(f"[{idx}/{count}] 失败 {display}：{message}")
        return JobResult(
            name=entry.name,
            rel=rel,
            path="",
            size=entry.size,
            state="failed",
            message=message,
        )


# ---------------------------------------------------------------------------
# 渲染：列表与树
# ---------------------------------------------------------------------------


def _dir_mark(entry: FileEntry) -> str:
    return "目录" if entry.is_dir else "文件"


def render_listing(entries: list[FileEntry], stream: Any = None) -> None:
    """`ls` 的表格：序号 / 类型 / 大小 / 名称（序号就是 get --index 用的）"""
    stream = stream or sys.stdout
    if not entries:
        stream.write("（这一层是空的）\n")
        return
    index_width = len(str(len(entries)))
    size_texts = [entry.size_text if not entry.is_dir else "—" for entry in entries]
    size_width = max(len(t) for t in size_texts) if size_texts else 0
    for i, entry in enumerate(entries, 1):
        suffix = "/" if entry.is_dir else ""
        stream.write(
            f"{i:>{index_width}}  {_dir_mark(entry):<2}  {size_texts[i - 1]:>{size_width}}  "
            f"{entry.name}{suffix}\n"
        )
    stream.flush()


def tree_nodes(
    adapter: Any, ctx: ShareCtx, entries: list[FileEntry], max_depth: int, depth: int = 0
) -> list[dict[str, Any]]:
    """把一层目录摊成嵌套结构（`tree --json` 和缩进打印共用）"""
    nodes: list[dict[str, Any]] = []
    for entry in entries:
        node: dict[str, Any] = {
            "type": "dir" if entry.is_dir else "file",
            "name": entry.name,
            "size": entry.size,
        }
        if entry.is_dir:
            if depth + 1 >= max_depth:
                node["truncated"] = True
                node["children"] = []
            else:
                try:
                    children = adapter.list_dir(ctx, entry.id)
                except Exception as e:  # noqa: BLE001 —— 单个目录失败不连坐
                    node["error"] = str(e)
                    node["children"] = []
                else:
                    node["children"] = tree_nodes(adapter, ctx, children, max_depth, depth + 1)
        nodes.append(node)
    return nodes


def render_tree(nodes: list[dict[str, Any]], stream: Any = None, prefix: str = "") -> None:
    stream = stream or sys.stdout
    for node in nodes:
        if node["type"] == "dir":
            stream.write(f"{prefix}{node['name']}/\n")
            if node.get("truncated"):
                stream.write(f"{prefix}  …（到达 --depth 上限，未展开）\n")
            if node.get("error"):
                stream.write(f"{prefix}  ! {node['error']}\n")
            render_tree(node.get("children") or [], stream, prefix + "  ")
        else:
            stream.write(f"{prefix}{node['name']}  {human_size(node.get('size') or 0)}\n")
    stream.flush()


# ---------------------------------------------------------------------------
# 子命令
# ---------------------------------------------------------------------------


def _pwd_arg(args: argparse.Namespace) -> str:
    return (getattr(args, "pwd", "") or "").strip()


def cmd_ls(args: argparse.Namespace) -> int:
    cfg = Config()
    adapter, _cls = open_adapter(args.url, cfg)
    ctx, root, title = parse_share(adapter, args.url, _pwd_arg(args))
    entries, walked = list_path(adapter, ctx, root, args.path)

    if args.json:
        payload = {
            "service": adapter.name,
            "title": title,
            "path": walked,
            "entries": [
                {
                    "index": i,
                    "name": entry.name,
                    "type": "dir" if entry.is_dir else "file",
                    "size": entry.size,
                    "size_text": entry.size_text,
                    "id": entry.id,
                }
                for i, entry in enumerate(entries, 1)
            ],
        }
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return EXIT_OK

    where = "/".join(walked) if walked else (title or "分享根目录")
    who = "已登录" if adapter.logged_in else adapter.anonymous_hint
    print(f"{adapter.name} · {where} · {who}")
    render_listing(entries)
    return EXIT_OK


def cmd_tree(args: argparse.Namespace) -> int:
    cfg = Config()
    adapter, _cls = open_adapter(args.url, cfg)
    ctx, root, title = parse_share(adapter, args.url, _pwd_arg(args))
    entries, walked = list_path(adapter, ctx, root, args.path)
    depth = clamp_depth(args.depth) if args.depth is not None else 3

    nodes = tree_nodes(adapter, ctx, entries, max(1, depth))
    if args.json:
        print(
            json.dumps(
                {
                    "service": adapter.name,
                    "title": title,
                    "path": walked,
                    "nodes": nodes,
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return EXIT_OK
    where = "/".join(walked) if walked else (title or "分享根目录")
    print(f"{adapter.name} · {where}（最多展开 {depth} 层）")
    render_tree(nodes)
    return EXIT_OK


def _join_rel(base: str, rel: str) -> str:
    return "/".join(part for part in (base, rel) if part)


def _list_glob(values: Any) -> list[str]:
    if not values:
        return []
    return [item for value in values for item in str(value).split(",") if item.strip()]


def _clamp_connections(value: Any) -> int:
    """并发连接：配置被手改坏也不至于炸（上限 128 是为了别把分享接口打急眼）"""
    try:
        number = int(value)
    except (TypeError, ValueError):
        return 16
    return max(1, min(number, 128))


def cmd_get(args: argparse.Namespace) -> int:
    # `--json` 意味着"stdout 只能有 JSON"：把人类可读的进度/摘要一起关掉，
    # 否则脚本 `| jq` 的第一个字符就是"假网盘 · 课程 · 2 项"。
    args.quiet = bool(args.quiet or args.json)
    cfg = Config()
    adapter, _cls = open_adapter(args.url, cfg)

    dest = Path(args.dest or cfg.data.get("dest_dir") or default_dest_dir()).expanduser()
    connections = _clamp_connections(args.connections or cfg.data.get("connections"))

    started = time.time()
    ctx, root, title = parse_share(adapter, args.url, _pwd_arg(args))
    entries, walked = list_path(adapter, ctx, root, args.path)

    # 选条目：--index 指定序号，否则整层；--only/--exclude 在展开后按路径过滤
    if args.index:
        indices = parse_index_spec(args.index, len(entries))
        picked = [entries[i] for i in indices]
    else:
        picked = list(entries)
    if not picked:
        raise CliError("没有选中任何条目")

    base_rel = "/".join(walked)
    cap = clamp_depth(args.max_depth if args.max_depth is not None else cfg.data.get("max_depth"))
    workers = clamp_workers(
        args.expand_workers if args.expand_workers is not None else cfg.data.get("expand_workers")
    )

    board = ProgressBoard()
    last_note = {"at": 0.0}

    def on_expand(prefix: str, found: int) -> None:
        # 展开几百个目录时逐条刷屏没意义：1.5 秒一条，
        # 而且只在真 tty 上打（管道里留给最终结果）
        if not board.tty or args.quiet:
            return
        now = time.time()
        if now - last_note["at"] < 1.5:
            return
        last_note["at"] = now
        board.line(f"正在展开目录：{prefix or '根目录'}（已找到 {found} 个文件）")

    if not args.quiet:
        where = base_rel or (title or "分享根目录")
        print(f"{adapter.name} · {where} · {len(picked)} 项")
    flat, notes = flatten(
        adapter,
        ctx,
        picked,
        max_depth=cap,
        workers=workers,
        progress=on_expand,
    )
    flat = [(_entry, _join_rel(base_rel, rel)) for _entry, rel in flat]
    flat = filter_files(flat, _list_glob(args.only), _list_glob(args.exclude))
    if args.limit and args.limit > 0:
        flat = flat[: args.limit]
    if not flat:
        raise CliError("选中的内容里没有匹配的可下载文件（用 ls / tree 看看）")

    for note in notes:
        print(f"提示：{note}", file=sys.stderr)

    total_size = sum(entry.size for entry, _rel in flat)
    if not args.quiet:
        print(f"共 {len(flat)} 个文件 · {human_size(total_size)} → {dest}")

    if args.dry_run:
        if args.json:
            print(
                json.dumps(
                    {
                        "service": adapter.name,
                        "title": title,
                        "dest": str(dest),
                        "total": len(flat),
                        "bytes": total_size,
                        "files": [
                            {
                                "name": entry.name,
                                "rel": rel,
                                "size": entry.size,
                                "path": str(dest / rel / entry.name) if rel else str(dest / entry.name),
                            }
                            for entry, rel in flat
                        ],
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
        else:
            for entry, rel in flat:
                print(f"  {rel + '/' if rel else ''}{entry.name}  {entry.size_text}")
        return EXIT_OK

    # 迅雷：大文件要转存才能取链，一次请求转存一批（逐个 = 每个文件开一次浏览器）
    prefetch = getattr(adapter, "prefetch", None)
    if prefetch is not None:
        if not args.quiet:
            print("迅雷：正在批量转存取直链（约 10~30 秒）…")
        try:
            prefetch(ctx, [entry for entry, _rel in flat])
        except NetdiskError as e:
            print(f"提示：部分文件没能取到直链：{e}", file=sys.stderr)
        else:
            note = str(ctx.get("refresh_note") or "")
            if note and not args.quiet:
                print(f"迅雷：{note}")

    opts = DownloadOptions(
        dest=dest,
        connections=connections,
        jobs=max(1, min(int(args.jobs or 1), 16)),
        overwrite=bool(args.overwrite),
        quiet=bool(args.quiet),
    )
    session = DownloadSession(adapter, ctx, opts, board)

    interrupted = False
    results: list[JobResult] = []
    try:
        results = session.run(flat)
    except KeyboardInterrupt:
        interrupted = True
        session.cancel()
        print("\n已中断（正在停掉下载线程…）", file=sys.stderr)

    done = [r for r in results if r.state == "done"]
    failed = [r for r in results if r.state not in ("done", "cancelled")]
    cancelled = [r for r in results if r.state == "cancelled"]
    got_bytes = sum(r.size for r in done)
    elapsed = max(0.001, time.time() - started)

    if args.json:
        print(
            json.dumps(
                {
                    "service": adapter.name,
                    "title": title,
                    "dest": str(dest),
                    "total": len(flat),
                    "done": len(done),
                    "failed": len(failed),
                    "cancelled": len(cancelled),
                    "bytes": got_bytes,
                    "seconds": round(elapsed, 2),
                    "files": [r.as_json() for r in results],
                },
                ensure_ascii=False,
                indent=2,
            )
        )
    else:
        speed = got_bytes / elapsed
        print(
            f"\n完成 {len(done)}/{len(flat)} 个 · {human_size(got_bytes)} · "
            f"用时 {elapsed:.1f}s（平均 {human_size(int(speed))}/s）"
        )
        if cancelled:
            print(f"取消 {len(cancelled)} 个")
        for result in failed:
            label = f"{result.rel}/{result.name}" if result.rel else result.name
            print(f"  失败 {label}：{result.message or result.state}", file=sys.stderr)

    if interrupted:
        return EXIT_INTERRUPT
    return EXIT_OK if not failed else EXIT_PARTIAL


def cmd_login(args: argparse.Namespace) -> int:
    cfg = Config()

    if args.which == "status":
        quark = QuarkAdapter()
        quark.configure(cfg.data)
        saved = cfg.saved_cookies("quark")
        if saved:
            quark.client.import_cookies(saved)
        names = quark.client.cookie_names()
        if names:
            key = "有" if "__puus" in names else "缺 __puus（多半没登录）"
            print(f"夸克：已保存 {len(names)} 项 Cookie，关键项 {key}")
        else:
            print("夸克：未登录（小文件仍能下，上限约 50MB）")
        marker = xunlei.login_marker()
        if marker:
            left = xunlei.login_expires_text(marker)
            who = marker.get("user_id") or "已登录"
            print(f"迅雷：已登录（user {who}）{(' · ' + left) if left else ''}")
        else:
            print("迅雷：未登录（小文件直接下；转存大文件要先扫码）")
        print(f"配置：{cfg.path}")
        return EXIT_OK

    if args.which == "quark":
        raw = args.cookie or ""
        if args.cookie_file:
            try:
                raw = (
                    sys.stdin.read()
                    if args.cookie_file == "-"
                    else Path(args.cookie_file).expanduser().read_text("utf-8")
                )
            except OSError as e:
                raise CliError(f"读不了 Cookie 文件：{args.cookie_file}（{e}）") from e
        if not raw and not sys.stdin.isatty():
            raw = sys.stdin.read()
        if not raw.strip():
            raise CliError(
                "没有拿到 Cookie。浏览器 F12 → Application → Cookies → pan.quark.cn "
                "复制该项下的内容，然后：\n"
                "  netdisk_cli.py login quark --cookie \"a=1; b=2\"\n"
                "  Get-Clipboard | netdisk_cli.py login quark"
            )
        adapter = QuarkAdapter()
        adapter.configure(cfg.data)
        adapter.client.clear_cookies()
        count = adapter.client.import_cookies(raw)
        if count == 0:
            raise CliError("这段内容里没有 Cookie（应形如 `a=1; b=2`）")
        cfg.set_cookies("quark", adapter.client.export_cookies())
        names = adapter.client.cookie_names()
        suffix = "关键项齐全" if "__puus" in names else "缺少 __puus，可能仍算未登录"
        print(f"已保存 {count} 项夸克 Cookie（{suffix}）→ {cfg.path}")
        return EXIT_OK

    # 迅雷：登录/检查/续期都要开 WebView（captcha 只能靠网页算）
    adapter = xunlei.XunleiAdapter()
    adapter.configure(cfg.data)
    if args.status:
        data = adapter.check_login()
    elif args.refresh:
        data = adapter.ensure_fresh()
    else:
        print("正在打开迅雷官方登录页，请在弹出的窗口里扫码…")
        data = adapter.login()

    if data.get("refreshed"):
        left = xunlei.login_expires_text({"expires_at": data.get("expires_at") or 0})
        print(f"登录态已续期{(' · ' + left) if left else ''}")
    elif data.get("logged_in"):
        who = data.get("user_id") or "未知账号"
        print(f"迅雷登录态有效（user {who}）")
    elif data.get("reason"):
        print(f"迅雷：{data['reason']}")
    marker = xunlei.login_marker()
    if marker:
        left = xunlei.login_expires_text(marker)
        print(f"本地登录标记：已登录{(' · ' + left) if left else ''}")
    else:
        print("本地登录标记：未登录")
    return EXIT_OK


def cmd_config(args: argparse.Namespace) -> int:
    cfg = Config()
    data = cfg.data
    changed = False

    if args.dest:
        data["dest_dir"] = str(Path(args.dest).expanduser())
        changed = True
    if args.connections:
        data["connections"] = _clamp_connections(args.connections)
        changed = True
    if args.max_depth is not None:
        data["max_depth"] = clamp_depth(args.max_depth)
        changed = True
    if args.expand_workers is not None:
        data["expand_workers"] = clamp_workers(args.expand_workers)
        changed = True
    if args.xunlei_cleanup is not None:
        data["xunlei_cleanup"] = bool(args.xunlei_cleanup)
        changed = True
    if args.xunlei_mirror is not None:
        data["xunlei_mirror"] = bool(args.xunlei_mirror)
        changed = True

    if changed:
        cfg.save()
        print(f"已保存 → {cfg.path}")

    print(json.dumps(cfg.masked(), ensure_ascii=False, indent=2))
    return EXIT_OK


# ---------------------------------------------------------------------------
# 命令行入口
# ---------------------------------------------------------------------------

EPILOG = """\
例子:
  netdisk_cli.py ls   "https://pan.quark.cn/s/xxxx"
  netdisk_cli.py tree "https://pan.xunlei.com/s/xxxx?pwd=abcd" --depth 2
  netdisk_cli.py get  "https://pan.quark.cn/s/xxxx" --only "*.mp4" -o D:\\片 -c 32
  netdisk_cli.py get  "https://pan.quark.cn/s/xxxx" --index 1,3-5 --dry-run
  Get-Clipboard | netdisk_cli.py login quark
  netdisk_cli.py login xunlei
  netdisk_cli.py config --dest "D:\\下载" --connections 32

配置与登录态在 %APPDATA%\\netdisk-downloader\\config.json（与 GUI 共用）。
"""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="netdisk_cli.py",
        description="网盘下载器（命令行版）：夸克 / 迅雷分享解析 + 多连接下载",
        epilog=EPILOG,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="cmd", metavar="{ls,tree,get,login,config}")
    sub.required = True

    def add_share_args(sp: argparse.ArgumentParser) -> None:
        sp.add_argument("url", help="分享链接（链接里可带 ?pwd=xxxx 提取码）")
        sp.add_argument("-p", "--pwd", default="", help="提取码（链接里带了就不用给）")
        sp.add_argument("--path", default="", help="分享内的子目录，如 课程/第1章")
        sp.add_argument("--json", action="store_true", help="输出 JSON（给脚本用）")

    ls = sub.add_parser("ls", help="列目录（序号可直接喂给 get --index）")
    add_share_args(ls)
    ls.set_defaults(func=cmd_ls)

    tree = sub.add_parser("tree", help="打印目录树")
    add_share_args(tree)
    tree.add_argument("--depth", type=int, default=3, help=f"最多展开几层（默认 3，上限 {MAX_DEPTH_LIMIT}）")
    tree.set_defaults(func=cmd_tree)

    get = sub.add_parser("get", help="下载（默认整份分享；可 --index/--only 挑）")
    add_share_args(get)
    get.add_argument("-o", "--dest", default="", help="保存目录（默认配置里的保存目录）")
    get.add_argument("-c", "--connections", type=int, default=0, help="每个文件的并发连接数（默认配置里的值）")
    get.add_argument("-j", "--jobs", type=int, default=1, help="同时下几个文件（默认 1）")
    get.add_argument("--index", default="", help="只下这一层的第几项，如 1,3-5（配合 --path）")
    get.add_argument("--only", action="append", default=[], help="只下匹配的文件名/路径 glob，可重复或逗号分隔")
    get.add_argument("--exclude", action="append", default=[], help="排除匹配的 glob")
    get.add_argument("--limit", type=int, default=0, help="最多下前 N 个文件（0 = 不限）")
    get.add_argument("--max-depth", type=int, default=None, help="展开目录的最大层数（覆盖配置）")
    get.add_argument("--expand-workers", type=int, default=None, help=f"展开目录的并发（1~{MAX_WORKERS}，覆盖配置）")
    get.add_argument("--overwrite", action="store_true", help="重名时覆盖（默认另存为 x (1).ext）")
    get.add_argument("--dry-run", action="store_true", help="只打印将要下的文件清单")
    get.add_argument("-q", "--quiet", action="store_true", help="只打结果行")
    get.set_defaults(func=cmd_get)

    login = sub.add_parser("login", help="登录态：夸克粘 Cookie / 迅雷扫码 / 看状态")
    login.add_argument("which", choices=["quark", "xunlei", "status"])
    login.add_argument("--cookie", default="", help="夸克 Cookie 串（a=1; b=2）")
    login.add_argument("--cookie-file", default="", help="从文件读 Cookie（- 表示 stdin）")
    login.add_argument("--status", action="store_true", help="迅雷：只检查登录态（会开隐藏窗口，5~10 秒）")
    login.add_argument("--refresh", action="store_true", help="迅雷：用 refresh_token 静默续期")
    login.set_defaults(func=cmd_login)

    config = sub.add_parser("config", help="查看/修改配置")
    config.add_argument("--dest", default="", help="默认保存目录")
    config.add_argument("--connections", type=int, default=0, help="默认并发连接数")
    config.add_argument("--max-depth", type=int, default=None, help="展开目录的最大层数")
    config.add_argument("--expand-workers", type=int, default=None, help="展开目录的并发")
    config.add_argument("--xunlei-cleanup", dest="xunlei_cleanup", action="store_true", default=None,
                        help="迅雷转存取链后删除云端副本")
    config.add_argument("--no-xunlei-cleanup", dest="xunlei_cleanup", action="store_false",
                        help="保留迅雷云端副本")
    config.add_argument("--xunlei-mirror", dest="xunlei_mirror", action="store_true", default=None,
                        help="迅雷直链换镜像节点（实验）")
    config.add_argument("--no-xunlei-mirror", dest="xunlei_mirror", action="store_false",
                        help="不换镜像节点（默认）")
    config.set_defaults(func=cmd_config)

    return parser


def main(argv: list[str] | None = None) -> int:
    safe_stdout()
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.func(args))
    except CliError as e:
        print(f"错误：{e}", file=sys.stderr)
        return EXIT_USAGE
    except NetdiskError as e:
        print(f"错误：{e}", file=sys.stderr)
        return EXIT_USAGE
    except KeyboardInterrupt:
        print("\n已中断", file=sys.stderr)
        return EXIT_INTERRUPT


if __name__ == "__main__":
    raise SystemExit(main())
