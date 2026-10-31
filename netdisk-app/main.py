"""网盘下载器 —— 独立软件入口（Tkinter 界面）

一个窗口、一个输入框，认得出**夸克**和**迅雷**两家的分享链接：

    粘贴链接（提取码在链接里也行）→ 解析目录 → 进子目录 / 多选 / 整目录
      → 多连接高速下载（分片、直链自愈、限流退避）

为什么是独立软件而不是留在插件里（两个网盘同理）：

- 插件跑在 WebView 里，**只在面板打开时运行** —— 关掉面板，直链过期就没人换链了；
  独立进程自己就能一直下、自己换链、最小化到后台也不受影响。
- 插件受应用 CSP 限制，既不能直接发请求也不能写文件；独立软件没有这些限制。

只用标准库（tkinter + urllib）；**迅雷的解析额外需要 pywebview**（复用系统 WebView2），
没装也不影响夸克 —— 点迅雷链接时会明确提示怎么装。
"""

from __future__ import annotations

import queue
import subprocess
import sys

# 不要在程序目录里写 __pycache__：
# 1) 它会跟着 Tauri 的 resources 一起被打进安装包（白占体积、看着也不干净）；
# 2) 装到 Program Files 这类只读位置时，写字节码还会失败。
# 必须在 import 本项目的包**之前**设置，所以放在所有本地 import 之前。
sys.dont_write_bytecode = True

import threading  # noqa: E402
import tkinter as tk  # noqa: E402
from pathlib import Path  # noqa: E402
from tkinter import filedialog, messagebox, ttk  # noqa: E402
from typing import Any  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))

from netdisk import xunlei  # noqa: E402
from netdisk.adapters import QuarkAdapter  # noqa: E402
from netdisk.config import CONNECTION_CHOICES, DEFAULT_CONNECTIONS, Config  # noqa: E402
from netdisk.core import (  # noqa: E402
    FileEntry,
    NetdiskError,
    ShareCtx,
    app_version,
    ensure_dir,
    fs_path,
)
from netdisk.downloader import DownloadTask, Downloader, safe_filename, unique_path  # noqa: E402
from netdisk.services import ADAPTERS, PLACEHOLDER, detect, host_lines, service_names  # noqa: E402
from netdisk.tree import (  # noqa: E402
    DEFAULT_MAX_DEPTH,
    DEFAULT_WORKERS,
    MAX_DEPTH_LIMIT,
    MAX_WORKERS,
    clamp_depth,
    clamp_workers,
    flatten,
)

APP_NAME = "网盘下载器"

STATE_TEXT = {
    "pending": "等待中",
    "running": "下载中",
    "expired": "直链过期，换链中…",
    "backoff": "限流退避中…",
    "done": "已完成",
    "failed": "失败",
    "cancelled": "已取消",
}


# 配置在 netdisk/config.py 里（GUI 与 CLI 共用同一份 config.json）


# ─────────────────────────── 主窗口 ───────────────────────────


class App(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title(APP_NAME)
        self.geometry("900x680")
        self.minsize(780, 540)

        self.cfg = Config()
        self.events: queue.Queue[tuple] = queue.Queue()
        # 每家网盘一个长期实例：夸克的匿名会话 Cookie 与直链是绑定的，
        # 每次解析都新建一个 Client 会把会话丢干净。
        self.adapters: dict[str, Any] = {}
        self.ctx: ShareCtx | None = None
        self.stack: list[tuple[str, str]] = []      # [(dir_id, name)] 面包屑
        self.entries: dict[str, FileEntry] = {}     # iid -> entry
        self.tasks: dict[int, DownloadTask] = {}
        self.downloaders: dict[int, Downloader] = {}
        self.task_sources: dict[int, tuple[Any, ShareCtx, FileEntry]] = {}
        self.next_task_id = 1

        self._build_ui()
        for cls in ADAPTERS:                        # 启动时把上次的登录态装回去
            self._adapter_instance(cls)
        self.after(200, self._pump)

    # ── 适配器实例 ──

    def _adapter_instance(self, cls: Any):
        """按网盘取（或建）那个长期实例，并灌上配置与已保存的 Cookie。"""
        inst = self.adapters.get(cls.session)
        if inst is not None:
            return inst
        inst = cls()
        inst.configure(self.cfg.data)
        saved = (self.cfg.data.get("cookies") or {}).get(cls.session)
        if saved:
            inst.client.import_cookies(saved)
        self.adapters[cls.session] = inst
        return inst

    def quark_adapter(self) -> QuarkAdapter:
        return self._adapter_instance(QuarkAdapter)  # type: ignore[return-value]

    def xunlei_adapter(self) -> xunlei.XunleiAdapter:
        return self._adapter_instance(xunlei.XunleiAdapter)  # type: ignore[return-value]

    # ── 界面 ──

    def _build_ui(self) -> None:
        pad = {"padx": 8, "pady": 4}

        # 顶部：链接 + 提取码 + 解析
        top = ttk.Frame(self)
        top.pack(fill="x", **pad)
        top.columnconfigure(1, weight=1)

        ttk.Label(top, text="分享链接").grid(row=0, column=0, sticky="w")
        self.url_var = tk.StringVar()
        url_entry = ttk.Entry(top, textvariable=self.url_var)
        url_entry.grid(row=0, column=1, sticky="ew", padx=6)
        url_entry.bind("<Return>", lambda _e: self.on_parse())
        url_entry.bind("<KeyRelease>", lambda _e: self._refresh_detected())
        self.parse_btn = ttk.Button(top, text="解析", command=self.on_parse)
        self.parse_btn.grid(row=0, column=2, sticky="e")

        ttk.Label(top, text="提取码").grid(row=1, column=0, sticky="w")
        self.pwd_var = tk.StringVar()
        pwd_entry = ttk.Entry(top, textvariable=self.pwd_var, width=12)
        pwd_entry.grid(row=1, column=1, sticky="w", padx=6, pady=(4, 0))
        pwd_entry.bind("<Return>", lambda _e: self.on_parse())

        self.hint = ttk.Label(top, text=PLACEHOLDER, foreground="#666")
        self.hint.grid(row=2, column=0, columnspan=3, sticky="w", pady=(2, 0))

        # 中部：文件列表
        mid = ttk.LabelFrame(self, text="分享内容")
        mid.pack(fill="both", expand=True, **pad)

        bar = ttk.Frame(mid)
        bar.pack(fill="x", padx=6, pady=(6, 2))
        self.back_btn = ttk.Button(bar, text="← 返回", command=self.on_back, state="disabled")
        self.back_btn.pack(side="left")
        self.crumb = ttk.Label(bar, text="（还没有解析）", foreground="#666")
        self.crumb.pack(side="left", padx=8)
        ttk.Button(bar, text="全选", command=lambda: self._select_all(True)).pack(side="right")
        ttk.Button(bar, text="取消选择", command=lambda: self._select_all(False)).pack(
            side="right", padx=6
        )

        cols = ("name", "size")
        self.tree = ttk.Treeview(mid, columns=cols, show="headings", selectmode="extended")
        self.tree.heading("name", text="名称（双击文件夹进入）")
        self.tree.heading("size", text="大小")
        self.tree.column("name", width=580, anchor="w")
        self.tree.column("size", width=110, anchor="e")
        self.tree.pack(fill="both", expand=True, side="left", padx=(6, 0), pady=6)
        self.tree.bind("<Double-1>", self.on_tree_double)
        sb = ttk.Scrollbar(mid, orient="vertical", command=self.tree.yview)
        sb.pack(side="right", fill="y", pady=6, padx=(0, 6))
        self.tree.configure(yscrollcommand=sb.set)

        actions = ttk.Frame(mid)
        actions.pack(fill="x", padx=6, pady=(0, 6))
        self.dl_btn = ttk.Button(actions, text="下载选中", command=self.on_download, state="disabled")
        self.dl_btn.pack(side="left")
        self.size_hint = ttk.Label(actions, text="", foreground="#666")
        self.size_hint.pack(side="left", padx=8)

        # 下部：下载队列
        bottom = ttk.LabelFrame(self, text="下载队列")
        bottom.pack(fill="both", expand=True, **pad)

        qcols = ("name", "progress", "speed", "state")
        self.qtree = ttk.Treeview(bottom, columns=qcols, show="headings", height=7)
        for key, text, width, anchor in (
            ("name", "文件", 400, "w"),
            ("progress", "进度", 150, "w"),
            ("speed", "速度", 100, "e"),
            ("state", "状态", 150, "w"),
        ):
            self.qtree.heading(key, text=text)
            self.qtree.column(key, width=width, anchor=anchor)
        self.qtree.pack(fill="both", expand=True, side="left", padx=(6, 0), pady=6)
        self.qtree.bind("<Double-1>", self.on_queue_double)
        qsb = ttk.Scrollbar(bottom, orient="vertical", command=self.qtree.yview)
        qsb.pack(side="right", fill="y", pady=6, padx=(0, 6))
        self.qtree.configure(yscrollcommand=qsb.set)

        qactions = ttk.Frame(bottom)
        qactions.pack(fill="x", padx=6, pady=(0, 6))
        ttk.Button(qactions, text="取消选中任务", command=self.on_cancel_task).pack(side="left")
        ttk.Button(qactions, text="打开所在文件夹", command=self.on_open_folder).pack(
            side="left", padx=6
        )
        ttk.Button(qactions, text="清除已完成", command=self.on_clear_done).pack(side="left")
        ttk.Button(qactions, text="设置…", command=self.open_settings).pack(side="right")

        # 状态栏
        self.status = tk.StringVar(value=f"就绪 · 支持 {' / '.join(service_names())}")
        ttk.Label(self, textvariable=self.status, relief="sunken", anchor="w").pack(
            fill="x", side="bottom"
        )

    def _refresh_detected(self) -> None:
        """输入时就告诉用户"这是哪家的链接"，不要等他点了解析才发现认不出。"""
        text = self.url_var.get().strip()
        if not text:
            self.hint.configure(text=PLACEHOLDER, foreground="#666")
            return
        cls = detect(text)
        if cls is not None:
            anonymous = "" if self._adapter_instance(cls).logged_in else " · 未登录"
            self.hint.configure(text=f"识别为：{cls.name}{anonymous}", foreground="#2E6BE6")
        else:
            self.hint.configure(
                text=f"认不出这家网盘（目前支持 {' / '.join(service_names())}）",
                foreground="#C45656",
            )

    # ── 事件泵：worker 线程只往队列里丢事件，界面更新全部在主线程做 ──

    def _pump(self) -> None:
        try:
            while True:
                kind, payload = self.events.get_nowait()
                if kind == "status":
                    self.status.set(payload)
                elif kind == "error":
                    self.status.set(payload)
                    messagebox.showerror("出错了", payload)
                elif kind == "info":
                    self.status.set(payload)
                elif kind == "parsed":
                    self._show_entries(*payload)
                elif kind == "task":
                    self._update_task_row(payload)
                elif kind == "enable":
                    self.parse_btn.configure(state="normal" if payload else "disabled")
        except queue.Empty:
            pass
        self.after(200, self._pump)

    # ── 解析 ──

    def on_parse(self) -> None:
        url = self.url_var.get().strip()
        if not url:
            messagebox.showinfo(APP_NAME, "先粘贴一个分享链接")
            return
        cls = detect(url)
        if cls is None:
            supported = "\n".join(f"　　· {line}" for line in host_lines())
            messagebox.showinfo(
                APP_NAME,
                "没认出这是哪家网盘的链接。\n\n"
                f"目前支持：\n{supported}",
            )
            return

        adapter = self._adapter_instance(cls)
        adapter.configure(self.cfg.data)
        pwd = self.pwd_var.get().strip()
        self.parse_btn.configure(state="disabled")
        self.status.set(adapter.parse_hint)
        self._clear_tree()

        def work() -> None:
            try:
                ctx, entries, title = adapter.parse(url, pwd)
                self.events.put(("parsed", (ctx, entries, title)))
            except NetdiskError as e:
                self.events.put(("error", str(e)))
            except Exception as e:  # 兜底，别让线程静默死掉
                self.events.put(("error", f"解析失败：{type(e).__name__}: {e}"))
            finally:
                self.events.put(("enable", True))

        threading.Thread(target=work, daemon=True).start()

    def _clear_tree(self) -> None:
        self.entries.clear()
        self.tree.delete(*self.tree.get_children())
        self.dl_btn.configure(state="disabled")
        self.crumb.configure(text="（还没有解析）")

    def _show_entries(self, ctx: ShareCtx, entries: list[FileEntry], title: str) -> None:
        self.ctx = ctx
        self.entries.clear()
        self.tree.delete(*self.tree.get_children())
        for e in entries:
            iid = self.tree.insert(
                "", "end", values=(("📁 " if e.is_dir else "📄 ") + e.name, e.size_text)
            )
            self.entries[iid] = e

        adapter = ctx.adapter
        crumb = " / ".join(n for _, n in self.stack) or (title or "分享根目录")
        who = "已登录" if adapter.logged_in else adapter.anonymous_hint
        self.crumb.configure(text=f"{adapter.name} · {crumb}    ·    {who}")
        self.back_btn.configure(state="normal" if self.stack else "disabled")
        self.dl_btn.configure(state="normal" if entries else "disabled")
        self.size_hint.configure(text=f"{len(entries)} 项")
        self.status.set(f"解析成功：{len(entries)} 项（{adapter.name}）")

    def _load_dir(self, dir_id: str, stack: list[tuple[str, str]]) -> None:
        ctx = self.ctx
        if ctx is None or ctx.adapter is None:
            return
        self.stack = stack
        self.status.set("正在读取目录…")

        def work() -> None:
            try:
                entries = ctx.adapter.list_dir(ctx, dir_id)
                self.events.put(("parsed", (ctx, entries, "")))
            except NetdiskError as e:
                self.events.put(("error", str(e)))
            except Exception as e:
                self.events.put(("error", f"读取目录失败：{e}"))

        threading.Thread(target=work, daemon=True).start()

    def on_tree_double(self, _event: Any) -> None:
        sel = self.tree.selection()
        if not sel:
            return
        entry = self.entries.get(sel[0])
        if entry and entry.is_dir:
            self._load_dir(entry.id, self.stack + [(entry.id, entry.name)])

    def on_back(self) -> None:
        ctx = self.ctx
        if ctx is None or not self.stack:
            return
        stack = self.stack[:-1]
        root_id = getattr(ctx.adapter, "root_id", "0")
        self._load_dir(stack[-1][0] if stack else root_id, stack)

    def _select_all(self, value: bool) -> None:
        self.tree.selection_set(self.tree.get_children() if value else ())

    # ── 下载 ──

    def _expand(
        self, adapter: Any, ctx: ShareCtx, picked: list[FileEntry]
    ) -> tuple[list[tuple[FileEntry, str]], list[str]]:
        """把勾选的条目展开成文件清单（真活儿在 `netdisk/tree.py`）。

        这里只负责两件事：把界面上那两个"展开"设置读出来、
        把进度塞进状态栏。展开本身是按层并发的显式队列，没有层数硬上限。
        """
        cap = clamp_depth(self.cfg.data.get("max_depth", DEFAULT_MAX_DEPTH))
        workers = clamp_workers(self.cfg.data.get("expand_workers", DEFAULT_WORKERS))
        return flatten(
            adapter,
            ctx,
            picked,
            max_depth=cap,
            workers=workers,
            progress=lambda rel, n: self.events.put(
                ("status", f"正在展开目录：{rel}（已找到 {n} 个文件）")
            ),
        )

    def on_download(self) -> None:
        ctx = self.ctx
        if ctx is None or ctx.adapter is None:
            return
        adapter = ctx.adapter
        picked = [self.entries[i] for i in self.tree.selection() if i in self.entries]
        if not picked:
            messagebox.showinfo(APP_NAME, "先在列表里选中要下载的文件或文件夹")
            return

        self.dl_btn.configure(state="disabled")
        self.status.set("正在展开目录并取直链…")

        def work() -> None:
            try:
                flat, notes = self._expand(adapter, ctx, picked)
                if notes:
                    # 跳过的是"到顶的子树"或"列不出来的目录"：剩下的照下，
                    # 不因为它们把整批任务否掉（旧版正是这么干的）
                    shown = "\n".join(notes[:5])
                    more = f"\n…还有 {len(notes) - 5} 条" if len(notes) > 5 else ""
                    self.events.put(("info", f"有 {len(notes)} 处没能展开：\n{shown}{more}"))
                if not flat:
                    raise NetdiskError("选中的内容里没有可下载的文件")

                # 批量预取：迅雷的"转存大文件"一次请求能处理多个文件，
                # 一次一次转存等于每个文件开一个浏览器（10 秒/个），根本没法用。
                prefetch = getattr(adapter, "prefetch", None)
                if prefetch is not None:
                    try:
                        prefetch(ctx, [e for e, _rel in flat])
                    except NetdiskError as e:
                        self.events.put(("info", f"部分文件没能取到直链：{e}"))
                    else:
                        note = str(ctx.get("refresh_note") or "")
                        if note:
                            self.events.put(("info", f"迅雷：{note}"))

                started = 0
                errors: list[str] = []
                for entry, rel in flat:
                    try:
                        self._start_one(adapter, ctx, entry, rel)
                        started += 1
                    except NetdiskError as e:
                        message = str(e)
                        # 适配器常常已经带上文件名（`XunleiAdapter.resolve()` 就会写），
                        # 别叠成"a.exe：a.exe：…"这种两个名字
                        errors.append(
                            message if message.startswith(entry.name) else f"{entry.name}：{message}"
                        )
                if errors:
                    self.events.put(("error", "部分文件没能开始下载：\n" + "\n".join(errors[:3])))
                else:
                    self.events.put(("info", f"已加入 {started} 个下载任务"))
            except NetdiskError as e:
                self.events.put(("error", str(e)))
            except Exception as e:
                self.events.put(("error", f"下载准备失败：{e}"))
            finally:
                self.events.put(("enable", True))

        threading.Thread(target=work, daemon=True).start()

    def _start_one(self, adapter: Any, ctx: ShareCtx, entry: FileEntry, rel: str) -> None:
        """取直链 → 建任务 → 起下载线程"""
        url, headers = adapter.resolve(ctx, entry)

        dest_dir = Path(self.cfg.data["dest_dir"])
        if rel:
            dest_dir = dest_dir / rel
        # 深层目录拼出来的绝对路径可能超过 MAX_PATH：ensure_dir 会按需加 `\\?\`
        ensure_dir(dest_dir)
        path = unique_path(dest_dir, safe_filename(entry.name))

        task = DownloadTask(
            id=self.next_task_id,
            name=path.name,
            url=url,
            path=path,
            connections=int(self.cfg.data.get("connections", DEFAULT_CONNECTIONS)),
        )
        self.next_task_id += 1
        self.tasks[task.id] = task
        self.task_sources[task.id] = (adapter, ctx, entry)

        def relink() -> str:
            """直链过期时回调：让适配器重新取一次（迅雷要先丢掉缓存的那条）。"""
            a, c, ent = self.task_sources[task.id]
            invalidate = getattr(a, "invalidate", None)
            if invalidate is not None:
                invalidate(c, ent)
            new_url, _h = a.resolve(c, ent)
            return new_url

        dl = Downloader(
            client=adapter.client,
            task=task,
            headers=headers,
            relink=relink,
            on_update=lambda t: self.events.put(("task", t)),
        )
        self.downloaders[task.id] = dl
        self.events.put(("task", task.snapshot()))
        threading.Thread(target=dl.run, daemon=True).start()

    def _update_task_row(self, task: DownloadTask) -> None:
        iid = str(task.id)
        values = (
            task.name,
            f"{task.progress:.1f}%" if task.total else "—",
            task.speed_text,
            STATE_TEXT.get(task.state, task.state),
        )
        if self.qtree.exists(iid):
            self.qtree.item(iid, values=values)
        else:
            self.qtree.insert("", "end", iid=iid, values=values)
        if task.state == "done":
            self.status.set(f"已完成：{task.name} → {task.path}")

    def _selected_task(self) -> DownloadTask | None:
        sel = self.qtree.selection()
        if not sel:
            return None
        return self.tasks.get(int(sel[0]))

    def on_cancel_task(self) -> None:
        task = self._selected_task()
        if task is None:
            messagebox.showinfo(APP_NAME, "先在下载队列里选中一个任务")
            return
        dl = self.downloaders.get(task.id)
        if dl:
            dl.cancel()
            self.status.set(f"正在取消：{task.name}")

    def on_open_folder(self) -> None:
        task = self._selected_task()
        if task is None:
            return
        folder = task.path.parent
        if not folder.exists():
            messagebox.showinfo(APP_NAME, "文件夹还不存在")
            return
        _open_in_explorer(folder)

    def on_clear_done(self) -> None:
        for tid, task in list(self.tasks.items()):
            if task.state in ("done", "failed", "cancelled"):
                if self.qtree.exists(str(tid)):
                    self.qtree.delete(str(tid))
                self.tasks.pop(tid, None)
                self.downloaders.pop(tid, None)
                self.task_sources.pop(tid, None)

    def on_queue_double(self, _event: Any) -> None:
        self.on_open_folder()

    # ── 设置 ──

    def open_settings(self) -> None:
        SettingsDialog(self)

    def save_cookies(self) -> None:
        """把各家的登录态存起来（迅雷不在这里，它的 token 只在 WebView 里）。"""
        jar = self.cfg.data.setdefault("cookies", {})
        for session, adapter in self.adapters.items():
            export = getattr(adapter.client, "export_cookies", None)
            if export is not None:
                jar[session] = export()
        self.cfg.save()


class SettingsDialog(tk.Toplevel):
    def __init__(self, app: App) -> None:
        super().__init__(app)
        self.app = app
        self.title("设置")
        self.transient(app)
        self.grab_set()
        self.geometry("680x520")
        self.resizable(True, True)
        self._q: queue.Queue[tuple] = queue.Queue()

        nb = ttk.Notebook(self)
        nb.pack(fill="both", expand=True, padx=10, pady=(10, 4))
        self._build_general(nb)
        self._build_quark(nb)
        self._build_xunlei(nb)

        bottom = ttk.Frame(self)
        bottom.pack(fill="x", padx=10, pady=(0, 10))
        ttk.Button(bottom, text="确定", command=self._ok).pack(side="right")
        ttk.Button(bottom, text="取消", command=self.destroy).pack(side="right", padx=6)

        self.after(150, self._drain)

    # ── 通用 ──
    def _build_general(self, nb: ttk.Notebook) -> None:
        page = ttk.Frame(nb)
        nb.add(page, text="通用")
        pad = {"padx": 12, "pady": 8}

        row = ttk.Frame(page)
        row.pack(fill="x", **pad)
        ttk.Label(row, text="保存到").pack(side="left")
        self.dest_var = tk.StringVar(value=str(self.app.cfg.data["dest_dir"]))
        ttk.Entry(row, textvariable=self.dest_var).pack(side="left", fill="x", expand=True, padx=6)
        ttk.Button(row, text="选择…", command=self._pick_dir).pack(side="left")

        row2 = ttk.Frame(page)
        row2.pack(fill="x", **pad)
        ttk.Label(row2, text="并发连接").pack(side="left")
        self.conn_var = tk.IntVar(value=int(self.app.cfg.data.get("connections", DEFAULT_CONNECTIONS)))
        ttk.Combobox(
            row2, textvariable=self.conn_var, values=CONNECTION_CHOICES, width=6, state="readonly"
        ).pack(side="left", padx=6)
        ttk.Label(
            row2,
            text="两家都按「连接」限速：并发越多越快，64 足够日常",
            foreground="#666",
        ).pack(side="left")

        row3 = ttk.Frame(page)
        row3.pack(fill="x", **pad)
        ttk.Label(row3, text="最多展开层数").pack(side="left")
        self.depth_var = tk.StringVar(
            value=str(int(self.app.cfg.data.get("max_depth") or DEFAULT_MAX_DEPTH))
        )
        ttk.Spinbox(
            row3,
            from_=1,
            to=MAX_DEPTH_LIMIT,
            textvariable=self.depth_var,
            width=6,
        ).pack(side="left", padx=6)
        ttk.Label(
            row3,
            text="勾选文件夹时往下展开多少层（默认 32；超出的子树会跳过并提示，不影响其它文件）",
            foreground="#666",
        ).pack(side="left")

        row4 = ttk.Frame(page)
        row4.pack(fill="x", **pad)
        ttk.Label(row4, text="展开并发").pack(side="left")
        self.workers_var = tk.StringVar(
            value=str(int(self.app.cfg.data.get("expand_workers") or DEFAULT_WORKERS))
        )
        ttk.Spinbox(
            row4,
            from_=1,
            to=MAX_WORKERS,
            textvariable=self.workers_var,
            width=6,
        ).pack(side="left", padx=6)
        ttk.Label(
            row4,
            text=(
                "同一层同时列几个目录（默认 6）。文件很多时展开快 N 倍；"
                "调太高容易被分享接口临时风控，整层会失败并提示"
            ),
            foreground="#666",
        ).pack(side="left")

        ttk.Label(
            page,
            text=(
                "说明：\n"
                "· 解析分享不需要登录；下载小文件也不需要。\n"
                "· 夸克未登录时单个文件上限约 50MB；登录后可以下 GB 级文件，速度也靠并发提上去。\n"
                "· 迅雷大文件要先转存到自己云盘才能取直链，那一步需要登录。\n"
                "· 展开目录是**按层并发**的（见上面的「展开并发」），文件很多时也只要几秒。\n"
                "· 目录按原结构落盘，深层目录（十几层）也能下：长路径会自动加 \\\\?\\ 前缀。"
            ),
            justify="left",
            foreground="#666",
            wraplength=620,
        ).pack(anchor="w", padx=12, pady=(4, 8))

    # ── 夸克 ──
    def _build_quark(self, nb: ttk.Notebook) -> None:
        page = ttk.Frame(nb)
        nb.add(page, text="夸克")
        pad = {"padx": 12, "pady": 6}

        ttk.Label(
            page,
            text=(
                "浏览器打开 pan.quark.cn 并登录 → F12 → Application → Cookies → "
                "只复制 quark.cn 域下的项，粘到下面\n"
                "（整份浏览器 Cookie 约 7KB、含大量无关域，服务端会直接掐断连接）"
            ),
            wraplength=640,
            justify="left",
            foreground="#666",
        ).pack(anchor="w", **pad)

        self.cookie_text = tk.Text(page, height=10, wrap="word")
        self.cookie_text.pack(fill="both", expand=True, padx=12, pady=4)
        adapter = self.app.quark_adapter()
        if adapter.client.cookie_names():
            self.cookie_text.insert("1.0", adapter.client.export_cookies())

        row = ttk.Frame(page)
        row.pack(fill="x", **pad)
        ttk.Button(row, text="保存登录态", command=self._save_quark).pack(side="left")
        ttk.Button(row, text="检查", command=self._check_quark).pack(side="left", padx=6)
        ttk.Button(row, text="清除", command=self._clear_quark).pack(side="left")
        self.quark_check = ttk.Label(row, text="", foreground="#666")
        self.quark_check.pack(side="left", padx=8)

    def _save_quark(self) -> None:
        raw = self.cookie_text.get("1.0", "end").strip()
        adapter = self.app.quark_adapter()
        adapter.client.clear_cookies()
        adapter.client.import_cookies(raw)
        self.app.save_cookies()
        self._check_quark()

    def _check_quark(self) -> None:
        names = self.app.quark_adapter().client.cookie_names()
        if not names:
            self.quark_check.configure(text="没有保存任何 Cookie")
            return
        if "__puus" not in names:
            self.quark_check.configure(text=f"已保存 {len(names)} 项，但缺少 __puus")
        else:
            self.quark_check.configure(text=f"已保存 {len(names)} 项，关键项齐全 ✓")

    def _clear_quark(self) -> None:
        self.app.quark_adapter().client.clear_cookies()
        self.cookie_text.delete("1.0", "end")
        self.app.save_cookies()
        self.quark_check.configure(text="已清除")

    # ── 迅雷 ──
    def _build_xunlei(self, nb: ttk.Notebook) -> None:
        page = ttk.Frame(nb)
        nb.add(page, text="迅雷")
        pad = {"padx": 12, "pady": 6}

        ttk.Label(
            page,
            text=(
                "迅雷的分享接口要求设备签名（captcha_sign），只能在网页里过 —— "
                "所以解析时会开一个无窗口浏览器（约 10~20 秒），这需要 pywebview：\n"
                "    python -m pip install pywebview\n"
                "登录方式只有一种：开一个官方登录页，扫一次码（token 留在 WebView 里）。"
            ),
            wraplength=640,
            justify="left",
            foreground="#666",
        ).pack(anchor="w", **pad)

        self.xunlei_state = ttk.Label(page, text=self._xunlei_state_text(), foreground="#333")
        self.xunlei_state.pack(anchor="w", padx=12, pady=(8, 2))

        row = ttk.Frame(page)
        row.pack(fill="x", **pad)
        self.xl_login_btn = ttk.Button(row, text="扫码登录…", command=self._xunlei_login)
        self.xl_login_btn.pack(side="left")
        self.xl_check_btn = ttk.Button(row, text="检查登录态", command=self._xunlei_check)
        self.xl_check_btn.pack(side="left", padx=6)
        self.xl_refresh_btn = ttk.Button(row, text="刷新登录态", command=self._xunlei_refresh)
        self.xl_refresh_btn.pack(side="left")
        ttk.Button(row, text="清除本地标记", command=self._xunlei_clear).pack(side="left", padx=6)

        self.xunlei_note = ttk.Label(page, text="", foreground="#666", wraplength=640,
                                     justify="left")
        self.xunlei_note.pack(anchor="w", padx=12, pady=(4, 8))

        box = ttk.Frame(page)
        box.pack(fill="x", **pad)
        self.xl_cleanup = tk.BooleanVar(value=bool(self.app.cfg.data.get("xunlei_cleanup", True)))
        ttk.Checkbutton(
            box,
            text="转存取链后立刻从云盘删掉副本（不删会白占空间）",
            variable=self.xl_cleanup,
        ).pack(anchor="w")
        self.xl_mirror = tk.BooleanVar(value=bool(self.app.cfg.data.get("xunlei_mirror", False)))
        ttk.Checkbutton(
            box,
            text="直链换镜像节点提速（实验；换错节点会失败，默认关）",
            variable=self.xl_mirror,
        ).pack(anchor="w", pady=(4, 0))

    def _xunlei_state_text(self) -> str:
        marker = xunlei.login_marker()
        if not marker:
            return "状态：未登录（小文件仍可直接下；转存大文件要先扫码）"
        left = xunlei.login_expires_text(marker)
        suffix = f" · {left}" if left else ""
        if marker.get("migrated"):
            return f"状态：已登录（登录态从旧版「迅雷下载器」迁移而来）{suffix}"
        who = marker.get("user_id") or "已登录"
        return f"状态：已登录（user {who}）{suffix}"

    def _xunlei_login(self) -> None:
        self.xl_login_btn.configure(state="disabled")
        self.xunlei_note.configure(text="已打开登录窗口：在窗口里扫码，成功后它会自己关掉…")
        adapter = self.app.xunlei_adapter()

        def work() -> None:
            try:
                data = adapter.login()
                self._q.put(("login_ok", data))
            except Exception as e:  # noqa: BLE001
                self._q.put(("login_err", str(e)))

        threading.Thread(target=work, daemon=True).start()

    def _xunlei_check(self) -> None:
        self.xl_check_btn.configure(state="disabled")
        self.xunlei_note.configure(text="正在检查（会开一个隐藏窗口读登录态，5~10 秒）…")
        adapter = self.app.xunlei_adapter()

        def work() -> None:
            try:
                self._q.put(("check_ok", adapter.check_login()))
            except Exception as e:  # noqa: BLE001
                self._q.put(("check_err", str(e)))

        threading.Thread(target=work, daemon=True).start()

    def _xunlei_refresh(self) -> None:
        """手动续期：转存时会自动续，这里是给"我想现在就把它续上"的人用的。"""
        self.xl_refresh_btn.configure(state="disabled")
        self.xunlei_note.configure(text="正在用 refresh_token 续期（约 5~10 秒）…")
        adapter = self.app.xunlei_adapter()

        def work() -> None:
            try:
                self._q.put(("refresh_ok", adapter.ensure_fresh()))
            except Exception as e:  # noqa: BLE001
                self._q.put(("refresh_err", str(e)))

        threading.Thread(target=work, daemon=True).start()

    def _xunlei_clear(self) -> None:
        try:
            xunlei.LOGIN_MARKER.unlink(missing_ok=True)
        except OSError:
            pass
        self.xunlei_state.configure(text=self._xunlei_state_text())
        self.xunlei_note.configure(
            text="已清除本地标记。注意：WebView 里的登录态还在，"
                 "想彻底退出要去网页版点退出登录。"
        )

    def _drain(self) -> None:
        """设置窗自己的小事件泵（登录/检查都在后台线程里跑）。"""
        try:
            while True:
                kind, payload = self._q.get_nowait()
                if kind == "login_ok":
                    who = (payload or {}).get("user_id") or "已保存"
                    self.xunlei_note.configure(text=f"登录成功（user {who}），token 已留在本机")
                    self.xunlei_state.configure(text=self._xunlei_state_text())
                elif kind == "login_err":
                    self.xunlei_note.configure(text=f"登录没完成：{payload}")
                elif kind == "check_ok":
                    if (payload or {}).get("logged_in"):
                        who = (payload or {}).get("user_id") or "未知账号"
                        self.xunlei_note.configure(text=f"登录态有效（user {who}）")
                        self.xunlei_state.configure(text=self._xunlei_state_text())
                    else:
                        self.xunlei_note.configure(text="WebView 里没有登录态，需要扫码登录")
                        self.xunlei_state.configure(text=self._xunlei_state_text())
                elif kind == "check_err":
                    self.xunlei_note.configure(text=f"检查失败：{payload}")
                elif kind == "refresh_ok":
                    info = payload or {}
                    note = info.get("reason") or ("已续期" if info.get("refreshed") else "没有续期")
                    if info.get("refreshed"):
                        left = xunlei.login_expires_text({"expires_at": info.get("expires_at") or 0})
                        note = f"已续期成功 · {left}" if left else "已续期成功"
                    self.xunlei_note.configure(text=note)
                    self.xunlei_state.configure(text=self._xunlei_state_text())
                elif kind == "refresh_err":
                    self.xunlei_note.configure(text=f"续期失败：{payload}")
                self.xl_login_btn.configure(state="normal")
                self.xl_check_btn.configure(state="normal")
                self.xl_refresh_btn.configure(state="normal")
        except queue.Empty:
            pass
        except tk.TclError:
            return          # 窗口已经被关掉了，别再排下一轮
        try:
            self.after(150, self._drain)
        except tk.TclError:
            pass

    # ── 公共 ──
    def _pick_dir(self) -> None:
        chosen = filedialog.askdirectory(initialdir=self.dest_var.get() or None)
        if chosen:
            self.dest_var.set(chosen)

    def _ok(self) -> None:
        data = self.app.cfg.data
        data["dest_dir"] = self.dest_var.get().strip() or str(Path.home() / "Downloads")
        data["connections"] = int(self.conn_var.get())
        try:
            depth = int(self.depth_var.get())
        except (tk.TclError, ValueError):
            depth = DEFAULT_MAX_DEPTH          # 输入框被清空/写了怪东西：回到默认
        data["max_depth"] = clamp_depth(depth)
        try:
            workers = int(self.workers_var.get())
        except (tk.TclError, ValueError):
            workers = DEFAULT_WORKERS
        data["expand_workers"] = clamp_workers(workers)
        data["xunlei_cleanup"] = bool(self.xl_cleanup.get())
        data["xunlei_mirror"] = bool(self.xl_mirror.get())
        self.app.cfg.save()
        for session, adapter in self.app.adapters.items():
            adapter.configure(data)
        self.destroy()


def _open_in_explorer(path: Path) -> None:
    try:
        if sys.platform == "win32":
            # 深层目录的路径可能超过 MAX_PATH，explorer 认 `\\?\` 形式
            subprocess.Popen(["explorer", fs_path(path)])
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(path)])
        else:
            subprocess.Popen(["xdg-open", str(path)])
    except Exception:
        pass


def main() -> int:
    # `--version`：给宿主/脚本用（宿主平时直接读 VERSION 文件，不启动 Python）
    if "--version" in sys.argv[1:]:
        print(f"netdisk-app {app_version()}")
        return 0
    app = App()
    app.mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
