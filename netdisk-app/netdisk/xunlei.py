"""迅雷云盘适配器

链路（全部在**分享页的上下文里**发，见 `bridge_worker.py` 里为什么必须这样）：

    GET  /share                 → pass_code_token + 根目录文件        （免登录）
    GET  /share/detail          → 子目录                             （免登录）
    GET  /share/file_info       → 分享内文件直链                      （免登录，小文件直接给）
    POST /share/restore         → 转存到自己云盘                      （需要登录）
    GET  /tasks/{id}            → 轮询转存任务，映射在 params.trace_file_ids
    GET  /files/{id}?space=     → 云盘文件直链（**不能**带 usage=CONSUME）

几个实测踩过的坑（都写在注释里，别再踩第二次）：

1. `/share` **不接受 `parent_id`** —— 传了会被静默忽略，永远返回根目录。
   子目录必须走 `/share/detail`。
2. 云盘文件取直链时**不能带 `usage=CONSUME`** —— 带了 `web_content_link` 会变成
   空字符串，`links` 也空掉；不带任何 usage 反而正常。这一点和 Gopeed 扩展的注释相反。
3. 转存任务的响应结构是 `{"kind":"drive#task","params":{"trace_file_ids":"{...}"}}`，
   也就是说映射在 `params.trace_file_ids`，而且值是 **JSON 字符串**（不是对象）。

与夸克的区别：迅雷的每一步都要过 WebView（captcha 签名），所以 `parse()` 一次性把
整棵树和直链都取回来，之后的 `list_dir` 只是查本地缓存 —— 翻目录不再开浏览器。
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable

from .core import (
    XUNLEI_REFERER,
    XUNLEI_UA,
    Client,
    FileEntry,
    NetdiskError,
    ShareCtx,
    epoch_seconds,
)

# ── 存储位置 ──
# 登录态只存在 WebView2 的 profile 里（localStorage + Cookies），
# 换目录等于换浏览器 → 要重扫码，所以这个路径不能随便动。
_APP_DIR = Path(os.environ.get("APPDATA") or Path.home()) / "netdisk-downloader"
_LOCAL_DIR = Path(os.environ.get("LOCALAPPDATA") or Path.home()) / "netdisk-downloader"
STORAGE_DIR = _LOCAL_DIR / "webview"
# 合并前的「迅雷下载器」把 profile 放在这里，第一次运行时搬过来（省一次扫码）
LEGACY_STORAGE_DIR = Path(os.environ.get("LOCALAPPDATA") or Path.home()) / "XunleiDL" / "webview"
# 旧程序那份 DPAPI 凭证文件。内容读不了（绑机器），但"在不在"足以判断它登录过 ——
# 用来在搬家之后补一个标记，免得升级上来的人凭空掉成"未登录"
LEGACY_CREDS_FILE = Path(os.environ.get("LOCALAPPDATA") or Path.home()) / "XunleiDL" / "credentials.bin"
LOGIN_MARKER = _APP_DIR / "xunlei_login.json"

WORKER = Path(__file__).resolve().parent / "bridge_worker.py"

RESOLVE_TIMEOUT = 300        # 19 文件 / 158GB 的分享实测 15 秒；留足余量
RESTORE_TIMEOUT = 300
LOGIN_TIMEOUT = 300
STATUS_TIMEOUT = 60

# 迅雷的整棵树是**一次解析**在网页里递归抓出来的（一个目录一次请求），
# 所以深度上限同时写在两处：这里的 `_index()` 和 `bridge_worker.JS_RESOLVE`
# 的 `__MAX_DEPTH__`。原来是 6/8，太浅 —— 夸克那边同样的 6 层上限直接导致
# "深层目录一个文件都下不了"，这里一起放宽到 24（再深的分享几乎不存在，
# 而且每多一层就多一次页面内请求，不能无上限）。
MAX_TREE_DEPTH = 24

LOGIN_HINT = (
    "这个大文件要先进你自己的迅雷云盘才能取到直链（转存取链后会自动删掉）。\n"
    "点「设置 → 迅雷」里的「扫码登录」，登一次即可；小文件不登录也能直接下。"
)

# LinkSwift 维护的镜像池，按集群分组。迅雷直链的域名可以换节点 —— 同一份内容、
# 不同 CDN 集群，挑快的那个下载。默认**不开**（换错节点会 403），设置里可选。
MIRROR_POOL: dict[str, list[str]] = {
    "aliyun08": [
        "vod0267-aliyun08-vip-lixian.xunlei.com",
        "vod3379-aliyun08-vip-lixian.xunlei.com",
        "vod0554-aliyun08-vip-lixian.xunlei.com",
        "vod0007-aliyun08-vip-lixian.xunlei.com",
    ],
    "aliyun04": [
        "vod3379-aliyun04-vip-lixian.xunlei.com",
        "vod0267-aliyun04-vip-lixian.xunlei.com",
        "vod0554-aliyun04-vip-lixian.xunlei.com",
    ],
    "aliyun06": [
        "vod0554-aliyun06-vip-lixian.xunlei.com",
        "vod3379-aliyun06-vip-lixian.xunlei.com",
        "vod0267-aliyun06-vip-lixian.xunlei.com",
    ],
    "h05": [
        "vod0007-h05-vip-lixian.xunlei.com",
        "vod0008-h05-vip-lixian.xunlei.com",
    ],
}
ALL_MIRRORS = [h for hosts in MIRROR_POOL.values() for h in hosts]


# ---------------------------------------------------------------------------
# 链接解析
# ---------------------------------------------------------------------------
_SHARE_RE = re.compile(r"pan\.xunlei\.com/s/([A-Za-z0-9_\-]+)")
_PWD_RE = re.compile(r"[?&#]pwd=([A-Za-z0-9]{1,8})", re.I)
_BARE_ID_RE = re.compile(r"^[A-Za-z0-9_\-]{10,}$")


def parse_share_url(text: str) -> tuple[str, str | None]:
    """从一整段分享文本里抽出 (share_id, pass_code)。

    兼容这些形态（用户是从聊天窗口里整段复制过来的，不可能只有一条干净链接）：

        https://pan.xunlei.com/s/XXXX?pwd=abcd
        https://pan.xunlei.com/s/XXXX#abcd
        「分享链接：https://... 提取码：abcd」
        直接给 share_id
    """
    text = (text or "").strip()
    if not text:
        raise NetdiskError("分享链接为空")

    m = _SHARE_RE.search(text)
    if m:
        share_id = m.group(1)
    elif _BARE_ID_RE.match(text):
        share_id = text
    else:
        raise NetdiskError("没认出迅雷云盘分享链接（应形如 https://pan.xunlei.com/s/xxx）")

    pwd = None
    m2 = _PWD_RE.search(text)
    if m2:
        pwd = m2.group(1)
    else:
        # 兼容 #abcd 这种老式写法（只在「什么都没有」时才认，避免把 #/list 当提取码）
        m3 = re.search(r"#([A-Za-z0-9]{4,8})\s*$", text)
        if m3:
            pwd = m3.group(1)
        else:
            # 兼容「提取码：abcd」「密码 abcd」
            m4 = re.search(r"(?:提取码|密码|口令)\s*[:：]?\s*([A-Za-z0-9]{1,8})", text)
            if m4:
                pwd = m4.group(1)
    return share_id, pwd


def login_marker() -> dict | None:
    """读本地登录标记（只有 user_id/时间，**没有 token**）；没有就当未登录。"""
    try:
        raw = LOGIN_MARKER.read_text("utf-8")
        data = json.loads(raw)
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def clear_login_marker() -> None:
    """本地标记说"已登录"、但服务端说没登录时用它 —— 别让界面继续撒谎。"""
    try:
        LOGIN_MARKER.unlink(missing_ok=True)
    except OSError:
        pass


def login_expires_text(marker: dict | None = None) -> str:
    """把标记里的过期时间翻成"还有多久"（界面显示用）。没信息就返回空串。"""
    marker = login_marker() if marker is None else marker
    if not marker:
        return ""
    # 标记是我们自己写的数字，但别处（老版本/手改）可能写成 ISO —— 都认
    expires_at = epoch_seconds(marker.get("expires_at"))
    if not expires_at:
        return ""
    left = expires_at - time.time()
    if left <= 0:
        return "已过期（下次转存会自动续期）"
    if left < 3600:
        return f"还有约 {max(1, int(left // 60))} 分钟"
    if left < 86400:
        return f"还有约 {left / 3600:.0f} 小时"
    return f"还有约 {left / 86400:.1f} 天"


def download_headers() -> dict[str, str]:
    """下迅雷直链必须带的头：Referer 不对会被 CDN 判盗链（403）。"""
    return {"User-Agent": XUNLEI_UA, "Referer": XUNLEI_REFERER}


# ---------------------------------------------------------------------------
# 子进程调用
# ---------------------------------------------------------------------------
def bridge_run(
    mode: str,
    *,
    share_id: str = "",
    pwd: str = "",
    ids: list[str] | None = None,
    cleanup: bool = True,
    timeout: float = RESOLVE_TIMEOUT,
    show: bool = False,
) -> dict:
    """调一次 `bridge_worker.py`，返回它写出来的 JSON。

    结果走文件而不是 stdout：主程序可能被 pythonw 启动，那种情况下子进程的
    stdout 不一定可读；而文件一定有。
    """
    if not WORKER.is_file():
        raise NetdiskError(f"找不到迅雷解析器：{WORKER}")

    tmpdir = Path(tempfile.mkdtemp(prefix="netdisk-xl-"))
    out = tmpdir / "result.json"
    cmd = [
        sys.executable, str(WORKER),
        "--mode", mode,
        "-o", str(out),
        "--storage", str(STORAGE_DIR),
        "--legacy-storage", str(LEGACY_STORAGE_DIR),
        "--legacy-login", str(LEGACY_CREDS_FILE),
        "--marker", str(LOGIN_MARKER),
        "--timeout", str(int(timeout)),
    ]
    if share_id:
        cmd += ["--share-id", share_id]
    if pwd:
        cmd += ["--pwd", pwd]
    if ids:
        cmd += ["--ids", ",".join(ids)]
    if mode == "restore":
        cmd.append("--cleanup" if cleanup else "--no-cleanup")
    if show:
        cmd.append("--show")

    try:
        proc = subprocess.run(
            cmd,
            cwd=str(WORKER.parent),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout + 90,
        )
    except subprocess.TimeoutExpired as e:
        raise NetdiskError(
            f"迅雷解析超时（{int(timeout)} 秒）：网页版接口可能卡住，稍后重试"
        ) from e
    except OSError as e:
        raise NetdiskError(f"启动迅雷解析器失败：{e}") from e

    data: dict[str, Any] = {}
    if out.is_file():
        try:
            data = json.loads(out.read_text("utf-8"))
        except Exception:
            data = {}
        finally:
            try:
                out.unlink()
                tmpdir.rmdir()
            except OSError:
                pass

    if not data:
        detail = ((proc.stderr or "") + (proc.stdout or "")).strip().replace("\n", " ")[:300]
        raise NetdiskError(
            f"迅雷解析器没有产出结果（退出码 {proc.returncode}）"
            + (f"：{detail}" if detail else "")
        )
    if data.get("state") != "done":
        raise NetdiskError(str(data.get("error") or "迅雷解析失败"))
    return data


# ---------------------------------------------------------------------------
# 适配器
# ---------------------------------------------------------------------------
class XunleiAdapter:
    """迅雷云盘：解析分享 → 列目录（本地缓存）→ 免登录取直链 / 转存取链"""

    name = "迅雷云盘"
    session = "xunlei"
    root_id = ""            # 迅雷的根目录用空字符串表示（夸克是 "0"）
    anonymous_hint = "未登录（小文件直接下；转存大文件要先扫码）"
    parse_hint = "正在解析（迅雷云盘）…会短暂启动一个无窗口浏览器，约 10~20 秒"
    example_host = "pan.xunlei.com"

    # 展开目录不需要并发：解析那一步已经把整棵树抓回本地了，
    # `list_dir()` 只是查字典（深度上限见 MAX_TREE_DEPTH）
    parallel_expand = False

    def __init__(self, runner: Callable[..., dict] | None = None) -> None:
        self.client = Client("xunlei", ua=XUNLEI_UA)
        # 允许注入（自测用）：否则构造出来就是真去开 WebView
        self._run = runner or bridge_run
        self.cleanup = True
        self.prefer_mirror = False
        # 挑中的镜像按"原始集群域名"缓存：一次分享里几十个文件都指向同一批节点，
        # 每个文件都重新 HEAD 一轮就是几十次 4 秒超时，纯属自残
        self._mirror_cache: dict[str, str] = {}

    # ── 配置 ──
    def configure(self, cfg: dict[str, Any]) -> None:
        self.cleanup = bool(cfg.get("xunlei_cleanup", True))
        self.prefer_mirror = bool(cfg.get("xunlei_mirror", False))

    # ── 识别 ──
    @staticmethod
    def match(url: str) -> bool:
        host = urllib.parse.urlparse(url or "").hostname or ""
        # 只认网盘域名；www.xunlei.com / 下载页之类的链接不该被当成分享
        return host.lower().endswith("pan.xunlei.com")

    @property
    def logged_in(self) -> bool:
        return login_marker() is not None

    # ── 解析 ──
    def parse(self, url: str, pwd: str = "") -> tuple[ShareCtx, list[FileEntry], str]:
        share_id, inline_pwd = parse_share_url(url)
        code = (pwd or inline_pwd or "").strip()

        data = self._run(
            "resolve", share_id=share_id, pwd=code, timeout=RESOLVE_TIMEOUT
        )

        ctx = ShareCtx(self)
        ctx["share_id"] = share_id
        ctx["pwd"] = code
        ctx["title"] = str(data.get("title") or "")
        ctx["pass_code_token"] = str(data.get("pass_code_token") or "")
        ctx["url"] = url
        ctx["links"] = {}
        ctx["tree"] = {}
        self._index(data.get("files") or [], "", ctx, depth=0)

        root = ctx["tree"].get("", [])
        title = ctx["title"] or "迅雷分享"
        with_link = sum(1 for _id in ctx["links"])
        ctx["stats"] = {"total": self._count_files(ctx["tree"]), "with_link": with_link}
        if not root:
            raise NetdiskError("分享是空的（或者这个分享只包含无法列出的内容）")
        return ctx, root, title

    def _index(self, nodes: list[dict], parent_id: str, ctx: ShareCtx, depth: int) -> None:
        """把 worker 返回的树摊成「父 id → 子项」的邻接表，顺便收直链。"""
        if depth > MAX_TREE_DEPTH:
            return
        entries: list[FileEntry] = []
        for raw in nodes or []:
            if not isinstance(raw, dict):
                continue
            fid = str(raw.get("id") or "")
            if not fid:
                continue
            kind = str(raw.get("kind") or "drive#file")
            entry = FileEntry(
                id=fid,
                name=str(raw.get("name") or "未命名"),
                size=int(raw.get("size") or 0),
                is_dir=kind.endswith("folder"),
                extra={"link_error": raw.get("linkError") or "", "md5": raw.get("md5") or ""},
            )
            entries.append(entry)
            link = str(raw.get("link") or "")
            if link:
                ctx["links"][fid] = link
            children = raw.get("children") or []
            if entry.is_dir:
                self._index(children, fid, ctx, depth + 1)
        ctx["tree"][parent_id] = entries

    @staticmethod
    def _count_files(tree: dict[str, list[FileEntry]]) -> int:
        return sum(
            1 for entries in tree.values() for e in entries if not e.is_dir
        )

    # ── 列目录（查缓存：解析时已经整棵树都拿回来了） ──
    def list_dir(self, ctx: ShareCtx, dir_id: str = "") -> list[FileEntry]:
        tree = ctx.get("tree") or {}
        if dir_id not in tree:
            raise NetdiskError(
                f"这个目录在解析时没有展开（层级超过 {MAX_TREE_DEPTH} 层）。"
                "迅雷要求一个目录一次请求，太深的分享无法一次全取；"
                "可以先把它的分享链接单独发出来。"
            )
        return list(tree[dir_id])

    # ── 取直链 ──
    def resolve(self, ctx: ShareCtx, entry: FileEntry) -> tuple[str, dict[str, str]]:
        link = (ctx.get("links") or {}).get(entry.id) or ""
        if not link:
            # 这一批已经试过转存并且失败了：别再为每个文件开一次浏览器（10 秒/个），
            # 直接把上一次的原因抛给他，队列里的下一个文件立刻失败。
            failed = str(ctx.get("restore_failed") or "")
            if failed:
                raise NetdiskError(f"{entry.name}：{failed}")
            self.prefetch(ctx, [entry])
            link = (ctx.get("links") or {}).get(entry.id) or ""
        if not link:
            raise NetdiskError(f"{entry.name}：没有取到直链（转存失败或云盘空间已满）")
        return self._maybe_mirror(link), download_headers()

    def invalidate(self, ctx: ShareCtx, entry: FileEntry) -> None:
        """直链过期时把缓存的那条丢掉 —— 否则 `resolve()` 会把同一条死链再交出去。"""
        (ctx.get("links") or {}).pop(entry.id, None)

    def prefetch(self, ctx: ShareCtx, entries: list[FileEntry]) -> None:
        """把一批"没有直链"的文件一次性转存 + 取链。

        为什么必须批量：每次转存都要开一次隐藏 WebView（约 10 秒）。逐个转存等于
        一个 20 文件的分享开 20 次浏览器，慢到没法用。
        """
        missing = [
            e for e in entries
            if not e.is_dir and not (ctx.get("links") or {}).get(e.id)
        ]
        if not missing:
            return
        if not self.logged_in:
            raise NetdiskError(LOGIN_HINT)

        # 新的一次尝试：把上一轮的失败原因清掉（用户可能刚清了云盘空间）
        ctx["restore_failed"] = ""
        try:
            data = self._run(
                "restore",
                share_id=str(ctx.get("share_id") or ""),
                pwd=str(ctx.get("pwd") or ""),
                ids=[e.id for e in missing],
                cleanup=self.cleanup,
                timeout=RESTORE_TIMEOUT,
            )
        except NetdiskError as e:
            # 本地标记说登录了、服务端说没登录 → 把标记清掉，界面别再显示"已登录"
            if str(e).startswith("NOT_LOGGED_IN"):
                clear_login_marker()
                ctx["restore_failed"] = LOGIN_HINT
                raise NetdiskError(LOGIN_HINT) from e
            ctx["restore_failed"] = str(e)
            raise

        got = 0
        for item in data.get("results") or []:
            if not isinstance(item, dict):
                continue
            src = str(item.get("source_id") or "")
            link = str(item.get("link") or "")
            if src and link:
                ctx["links"][src] = link
                got += 1
        # worker 在转存前后可能自动续期过登录态，带上这句给界面看
        note = str(data.get("refresh") or "")
        if note:
            ctx["refresh_note"] = note
        if got == 0:
            reason = (
                "转存成功但没取到直链：多半是迅雷云盘空间已满（转存要占空间），"
                "清一下再试；也可能是账号被限流，过几分钟再来"
            )
            ctx["restore_failed"] = reason
            raise NetdiskError(reason)

    # ── 登录 ──
    def login(self, timeout: float = LOGIN_TIMEOUT) -> dict:
        """开一个**可见**窗口让用户扫码；成功后 worker 会写本地标记。"""
        return self._run("login", timeout=timeout)

    def check_login(self) -> dict:
        """开一个隐藏窗口读 localStorage，确认登录态还有效（会花 5~10 秒）。"""
        return self._run("status", timeout=STATUS_TIMEOUT)

    def ensure_fresh(self, timeout: float = STATUS_TIMEOUT) -> dict:
        """用 refresh_token 静默续期。

        转存路径**自己会续**（同一个窗口里做的，见 `bridge_worker.run_restore`），
        所以这个方法是给「设置 → 刷新登录态」按钮和排查用的：明说"续一次"，
        成功与否都返回原因，不抛异常。
        """
        return self._run("refresh", timeout=timeout)

    # ── 镜像（实验） ──
    def _maybe_mirror(self, link: str) -> str:
        if not self.prefer_mirror:
            return link
        host = urllib.parse.urlparse(link).hostname or ""
        cached = self._mirror_cache.get(host)
        if cached:
            return swap_mirror(link, cached)
        best = self.probe_best_mirror(link)
        if not best:
            return link
        self._mirror_cache[host] = best
        return swap_mirror(link, best)

    def probe_best_mirror(self, link: str, limit: int = 6, timeout: float = 4.0) -> str | None:
        """对候选镜像发 HEAD，挑最快的那个；全都不通就返回 None（用原链接）。"""
        hosts = [h for h in ALL_MIRRORS if h not in link][:limit]
        best: tuple[str, float] | None = None
        for host in hosts:
            url = swap_mirror(link, host)
            t0 = time.time()
            try:
                req = urllib.request.Request(
                    url, method="HEAD", headers=download_headers()
                )
                with self.client.opener.open(req, timeout=timeout):
                    pass
                cost = time.time() - t0
            except Exception:
                continue
            if best is None or cost < best[1]:
                best = (host, cost)
        return best[0] if best else None


def swap_mirror(link: str, host: str) -> str:
    """只换域名，路径和签名参数原样保留。"""
    return re.sub(r"^(https?)://[^/]+", rf"\1://{host}", link, count=1)
