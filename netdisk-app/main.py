"""网盘下载器 —— 独立软件入口（Tkinter 界面）

为什么做成独立软件而不是只留在 InfoBoard 里：
- 插件跑在 WebView 里，只在面板打开时运行 —— 关掉面板，直链过期就没人换链了；
  独立进程自己就能一直下、自己换链、最小化到后台也不受影响。
- 插件受应用 CSP 限制，既不能直接发请求也不能写文件；独立软件没有这些限制。

功能：
  链接 + 提取码 → 解析目录 →（可进子目录、可多选/整目录）→ 多连接高速下载
  队列显示进度/速度/状态，可取消、可打开所在文件夹；设置里可改并发数、保存目录、夸克登录态。

只用标准库（tkinter + urllib），不需要 pip 安装任何东西。
"""

from __future__ import annotations

import json
import os
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

from netdisk.adapters import QuarkAdapter  # noqa: E402
from netdisk.core import FileEntry, NetdiskError, ShareCtx, human_size  # noqa: E402
from netdisk.downloader import DownloadTask, Downloader, safe_filename, unique_path  # noqa: E402

APP_NAME = "网盘下载器"
ADAPTERS = [QuarkAdapter]
DEFAULT_CONNECTIONS = 16
CONNECTION_CHOICES = [1, 2, 4, 8, 16, 24, 32, 48, 64]


# ─────────────────────────── 配置 ───────────────────────────


class Config:
    """配置与登录态落盘（JSON）

    注意：夸克 Cookie 存在这个文件里（明文）。它等价于登录态，
    所以别把这个文件拷给别人 —— README 里也写了。
    """

    def __init__(self) -> None:
        base = Path(os.environ.get("APPDATA") or Path.home()) / "netdisk-downloader"
        base.mkdir(parents=True, exist_ok=True)
        self.path = base / "config.json"
        self.data: dict[str, Any] = {
            "dest_dir": str(Path.home() / "Downloads"),
            "connections": DEFAULT_CONNECTIONS,
            "cookies": {},
        }
        self.load()

    def load(self) -> None:
        try:
            if self.path.exists():
                saved = json.loads(self.path.read_text("utf-8"))
                if isinstance(saved, dict):
                    self.data.update(saved)
        except Exception:
            pass  # 配置坏了不该阻止启动

    def save(self) -> None:
        try:
            self.path.write_text(json.dumps(self.data, ensure_ascii=False, indent=2), "utf-8")
        except Exception:
            pass


# ─────────────────────────── 主窗口 ───────────────────────────


class App(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title(APP_NAME)
        self.geometry("880x660")
        self.minsize(760, 520)

        self.cfg = Config()
        self.events: queue.Queue[tuple] = queue.Queue()
        self.adapter: Any = None
        self.ctx: ShareCtx | None = None
        self.stack: list[tuple[str, str]] = []  # [(dir_id, name)] 面包屑
        self.entries: dict[str, FileEntry] = {}  # iid -> entry
        self.tasks: dict[int, DownloadTask] = {}
        self.downloaders: dict[int, Downloader] = {}
        self.task_sources: dict[int, tuple[ShareCtx, FileEntry]] = {}
        self.next_task_id = 1
        self._build_ui()
        self._install_cookies()
        self.after(200, self._pump)

    # ── 界面 ──

    def _build_ui(self) -> None:
        pad = {"padx": 8, "pady": 4}

        # 顶部：链接 + 提取码 + 解析
        top = ttk.Frame(self)
        top.pack(fill="x", **pad)
        ttk.Label(top, text="分享链接").pack(side="left")
        self.url_var = tk.StringVar()
        url_entry = ttk.Entry(top, textvariable=self.url_var)
        url_entry.pack(side="left", fill="x", expand=True, padx=6)
        url_entry.bind("<Return>", lambda _e: self.on_parse())
        ttk.Label(top, text="提取码").pack(side="left")
        self.pwd_var = tk.StringVar()
        pwd_entry = ttk.Entry(top, textvariable=self.pwd_var, width=10)
        pwd_entry.pack(side="left", padx=6)
        pwd_entry.bind("<Return>", lambda _e: self.on_parse())
        self.parse_btn = ttk.Button(top, text="解析", command=self.on_parse)
        self.parse_btn.pack(side="left")

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
        self.tree.column("name", width=560, anchor="w")
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
        self.hint = ttk.Label(actions, text="", foreground="#666")
        self.hint.pack(side="left", padx=8)

        # 下部：下载队列
        bottom = ttk.LabelFrame(self, text="下载队列")
        bottom.pack(fill="both", expand=True, **pad)

        qcols = ("name", "progress", "speed", "state")
        self.qtree = ttk.Treeview(bottom, columns=qcols, show="headings", height=7)
        for key, text, width, anchor in (
            ("name", "文件", 380, "w"),
            ("progress", "进度", 150, "w"),
            ("speed", "速度", 100, "e"),
            ("state", "状态", 140, "w"),
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
        ttk.Button(qactions, text="打开所在文件夹", command=self.on_open_folder).pack(side="left", padx=6)
        ttk.Button(qactions, text="清除已完成", command=self.on_clear_done).pack(side="left")
        ttk.Button(qactions, text="设置…", command=self.open_settings).pack(side="right")

        # 状态栏
        self.status = tk.StringVar(value="就绪")
        ttk.Label(self, textvariable=self.status, relief="sunken", anchor="w").pack(
            fill="x", side="bottom"
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

    def _pick_adapter(self, url: str):
        for cls in ADAPTERS:
            if cls.match(url):
                if self.adapter is None or not isinstance(self.adapter, cls):
                    self.adapter = cls()
                return self.adapter
        return None

    def on_parse(self) -> None:
        url = self.url_var.get().strip()
        if not url:
            messagebox.showinfo(APP_NAME, "先粘贴一个夸克分享链接")
            return
        adapter = self._pick_adapter(url)
        if adapter is None:
            messagebox.showinfo(APP_NAME, "目前只支持夸克网盘分享链接（https://pan.quark.cn/s/…）")
            return

        pwd = self.pwd_var.get().strip()
        self.parse_btn.configure(state="disabled")
        self.status.set("正在解析…")

        def work() -> None:
            try:
                ctx, entries, title = adapter.parse(url, pwd)
                self.events.put(("parsed", (ctx, entries, title, [])))
            except NetdiskError as e:
                self.events.put(("error", str(e)))
            except Exception as e:  # 兜底，别让线程静默死掉
                self.events.put(("error", f"解析失败：{type(e).__name__}: {e}"))
            finally:
                self.events.put(("enable", True))

        threading.Thread(target=work, daemon=True).start()

    def _show_entries(
        self, ctx: ShareCtx, entries: list[FileEntry], title: str, stack: list[tuple[str, str]]
    ) -> None:
        self.ctx = ctx
        self.stack = stack
        self.entries.clear()
        self.tree.delete(*self.tree.get_children())
        for e in entries:
            iid = self.tree.insert("", "end", values=(("📁 " if e.is_dir else "📄 ") + e.name, e.size_text))
            self.entries[iid] = e
        crumb = " / ".join(n for _, n in stack) or (title or "分享根目录")
        who = "已登录" if getattr(self.adapter, "logged_in", False) else "未登录（只能下 ~50MB 以内的文件）"
        self.crumb.configure(text=f"{crumb}    ·    {who}")
        self.back_btn.configure(state="normal" if stack else "disabled")
        self.dl_btn.configure(state="normal" if entries else "disabled")
        self.status.set(f"解析成功：{len(entries)} 项")

    def _load_dir(self, dir_id: str, stack: list[tuple[str, str]]) -> None:
        if self.ctx is None or self.adapter is None:
            return
        self.status.set("正在读取目录…")

        def work() -> None:
            try:
                entries = self.adapter.list_dir(self.ctx, dir_id)
                self.events.put(("parsed", (self.ctx, entries, "", stack)))
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
        if not self.stack:
            return
        stack = self.stack[:-1]
        self._load_dir(stack[-1][0] if stack else "0", stack)

    def _select_all(self, value: bool) -> None:
        self.tree.selection_set(self.tree.get_children() if value else ())

    # ── 下载 ──

    def _walk(self, ctx: ShareCtx, entry: FileEntry, rel: str, out: list[tuple[FileEntry, str]], depth: int = 0) -> None:
        """把目录展开成文件清单（递归）"""
        if not entry.is_dir:
            out.append((entry, rel))
            return
        if depth >= 6:
            raise NetdiskError("目录层级过深（超过 6 层），已停止展开")
        children = self.adapter.list_dir(ctx, entry.id)
        nxt = f"{rel}/{safe_filename(entry.name)}" if rel else safe_filename(entry.name)
        for c in children:
            self._walk(ctx, c, nxt, out, depth + 1)

    def on_download(self) -> None:
        if self.ctx is None or self.adapter is None:
            return
        picked = [self.entries[i] for i in self.tree.selection() if i in self.entries]
        if not picked:
            messagebox.showinfo(APP_NAME, "先在列表里选中要下载的文件或文件夹")
            return
        self.dl_btn.configure(state="disabled")
        self.status.set("正在展开目录并取直链…")
        ctx = self.ctx

        def work() -> None:
            try:
                flat: list[tuple[FileEntry, str]] = []
                for e in picked:
                    self._walk(ctx, e, "", flat)
                started = 0
                errors: list[str] = []
                for entry, rel in flat:
                    try:
                        self._start_one(ctx, entry, rel)
                        started += 1
                    except NetdiskError as e:
                        errors.append(f"{entry.name}：{e}")
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

    def _start_one(self, ctx: ShareCtx, entry: FileEntry, rel: str) -> None:
        """取直链 → 建任务 → 起下载线程"""
        assert self.adapter is not None
        url, headers = self.adapter.resolve(ctx, entry)

        dest_dir = Path(self.cfg.data["dest_dir"])
        if rel:
            dest_dir = dest_dir / rel
        dest_dir.mkdir(parents=True, exist_ok=True)
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
        self.task_sources[task.id] = (ctx, entry)

        def relink() -> str:
            """直链过期时回调：重新解析一次，拿新的直链"""
            c, ent = self.task_sources[task.id]
            new_url, _h = self.adapter.resolve(c, ent)  # type: ignore[union-attr]
            return new_url

        dl = Downloader(
            client=self.adapter.client,  # type: ignore[union-attr]
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
            {
                "pending": "等待中",
                "running": "下载中",
                "expired": "直链过期，换链中…",
                "backoff": "限流退避中…",
                "done": "已完成",
                "failed": "失败",
                "cancelled": "已取消",
            }.get(task.state, task.state),
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

    def _install_cookies(self) -> None:
        """启动时把上次保存的登录态装回去"""
        saved = self.cfg.data.get("cookies") or {}
        for cls in ADAPTERS:
            raw = saved.get(cls.session)
            if raw:
                adapter = cls()
                adapter.client.import_cookies(raw)
                if cls is QuarkAdapter:
                    self.adapter = adapter

    def open_settings(self) -> None:
        SettingsDialog(self)

    def save_cookies(self) -> None:
        raw = self.adapter.client.export_cookies() if self.adapter else ""
        self.cfg.data.setdefault("cookies", {})[QuarkAdapter.session] = raw
        self.cfg.save()


class SettingsDialog(tk.Toplevel):
    def __init__(self, app: App) -> None:
        super().__init__(app)
        self.app = app
        self.title("设置")
        self.transient(app)
        self.grab_set()
        self.geometry("620x440")

        pad = {"padx": 10, "pady": 6}

        # 保存目录
        row = ttk.Frame(self)
        row.pack(fill="x", **pad)
        ttk.Label(row, text="保存到").pack(side="left")
        self.dest_var = tk.StringVar(value=str(app.cfg.data["dest_dir"]))
        ttk.Entry(row, textvariable=self.dest_var).pack(side="left", fill="x", expand=True, padx=6)
        ttk.Button(row, text="选择…", command=self._pick_dir).pack(side="left")

        # 并发数
        row2 = ttk.Frame(self)
        row2.pack(fill="x", **pad)
        ttk.Label(row2, text="并发连接").pack(side="left")
        self.conn_var = tk.IntVar(value=int(app.cfg.data.get("connections", DEFAULT_CONNECTIONS)))
        ttk.Combobox(
            row2, textvariable=self.conn_var, values=CONNECTION_CHOICES, width=6, state="readonly"
        ).pack(side="left", padx=6)
        ttk.Label(
            row2,
            text="夸克按「连接」限速：并发越多越快（实测 512 并发可到 20MB/s+，上限 64 足够日常）",
            foreground="#666",
        ).pack(side="left")

        # 夸克登录
        box = ttk.LabelFrame(self, text="夸克登录（不登录只能下 ~50MB 以内的文件）")
        box.pack(fill="both", expand=True, **pad)
        ttk.Label(
            box,
            text="在浏览器打开 pan.quark.cn 并登录 → F12 → Application → Cookies → "
            "只复制 quark.cn 域下的项，粘到下面（整份浏览器 Cookie 会被服务端掐断连接）",
            wraplength=580,
            justify="left",
            foreground="#666",
        ).pack(anchor="w", padx=8, pady=(6, 2))
        self.cookie_text = tk.Text(box, height=8, wrap="word")
        self.cookie_text.pack(fill="both", expand=True, padx=8, pady=4)
        if app.adapter is not None:
            self.cookie_text.insert("1.0", app.adapter.client.export_cookies())

        row3 = ttk.Frame(box)
        row3.pack(fill="x", padx=8, pady=(0, 8))
        ttk.Button(row3, text="保存登录态", command=self._save_cookies).pack(side="left")
        ttk.Button(row3, text="检查", command=self._check).pack(side="left", padx=6)
        ttk.Button(row3, text="清除", command=self._clear).pack(side="left")
        self.check_label = ttk.Label(row3, text="", foreground="#666")
        self.check_label.pack(side="left", padx=8)

        bottom = ttk.Frame(self)
        bottom.pack(fill="x", **pad)
        ttk.Button(bottom, text="确定", command=self._ok).pack(side="right")
        ttk.Button(bottom, text="取消", command=self.destroy).pack(side="right", padx=6)

    def _pick_dir(self) -> None:
        chosen = filedialog.askdirectory(initialdir=self.dest_var.get() or None)
        if chosen:
            self.dest_var.set(chosen)

    def _save_cookies(self) -> None:
        raw = self.cookie_text.get("1.0", "end").strip()
        adapter = self.app.adapter or QuarkAdapter()
        adapter.client.clear_cookies()
        n = adapter.client.import_cookies(raw)
        self.app.adapter = adapter
        self.app.save_cookies()
        self._check()

    def _check(self) -> None:
        adapter = self.app.adapter
        if adapter is None:
            self.check_label.configure(text="还没有保存任何登录态")
            return
        names = adapter.client.cookie_names()
        if not names:
            self.check_label.configure(text="没有保存任何 Cookie")
            return
        missing = [n for n in ("__puus",) if n not in names]
        if missing:
            self.check_label.configure(text=f"已保存 {len(names)} 项，但缺少 {', '.join(missing)}")
        else:
            self.check_label.configure(text=f"已保存 {len(names)} 项，关键项齐全 ✓")

    def _clear(self) -> None:
        if self.app.adapter is not None:
            self.app.adapter.client.clear_cookies()
        self.cookie_text.delete("1.0", "end")
        self.app.save_cookies()
        self.check_label.configure(text="已清除")

    def _ok(self) -> None:
        self.app.cfg.data["dest_dir"] = self.dest_var.get().strip() or str(Path.home() / "Downloads")
        self.app.cfg.data["connections"] = int(self.conn_var.get())
        self.app.cfg.save()
        self.destroy()


def _open_in_explorer(path: Path) -> None:
    try:
        if sys.platform == "win32":
            subprocess.Popen(["explorer", str(path)])
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(path)])
        else:
            subprocess.Popen(["xdg-open", str(path)])
    except Exception:
        pass


def main() -> int:
    app = App()
    app.mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
