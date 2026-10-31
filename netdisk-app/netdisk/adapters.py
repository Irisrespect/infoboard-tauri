"""夸克网盘适配器

协议序列来自本机可复现的实测（见仓库 docs/NETDISK_PLUGIN.md 与调研文件夹）：

    1) POST /1/clouddrive/share/sharepage/token   {pwd_id, passcode}     → data.stoken   （免登录）
    2) GET  /1/clouddrive/share/sharepage/detail  pwd_id, stoken, pdir_fid
       → data.list[]: fid / file_name / size / dir / share_fid_token                    （免登录）
       一页最多 200 项，装不下要按 `_page` 翻页（见 `list_dir`）
    3) POST /1/clouddrive/file/download           {fids, fids_token, pwd_id, stoken}
       → data[0].download_url                                                           （★免转存）
    4) 直链 GET + Range，必须带会话 Cookie，UA 与取链时一致 → 206 分片

两个档位的差别（实测）：

| | 匿名（不登录） | 登录后 |
|---|---|---|
| 单文件大小 | ≤ 约 50MB（38.6MB 可 / 68.6MB 报 `23018`） | 1.2GB+ 正常 |
| 速度 | 0.17–0.75 MB/s，**加并发无效**（按整体限速） | 按连接限速，多连接可叠加 |

所以：小文件不登录也能下；想快必须登录并开多连接。
"""

from __future__ import annotations

import re
import time
import urllib.parse
from typing import Any

from .core import QUARK_UA, Client, FileEntry, NetdiskError, ShareCtx

API = "https://drive-pc.quark.cn"
REFERER = "https://pan.quark.cn/"

# 造成"取不到直链"的常见业务码 → 人话
#
# 14001 是实测校正过的：拿一个格式合法但不存在的 pwd_id 打 detail 接口，
# 返回的是 `400 code=14001 Bad Parameter: [分享链接不正确]` —— 它是**参数/链接不对**
# 这一类错误，不专指"stoken 过期"。两者动作一样（都该重新解析），但提示要写对，
# 否则用户会以为只是会话过期，反复重试同一个坏链接。
CODE_HINTS = {
    41006: "分享不存在或已被删除",
    41008: "提取码错误",
    41009: "该分享需要提取码",
    41010: "提取码错误",
    14001: "分享链接或会话参数不正确（链接可能已失效，请确认后重新解析）",
}

DOWNLOAD_HEADERS = {
    "User-Agent": QUARK_UA,
    "Referer": REFERER,
}


def _headers() -> dict[str, str]:
    return {
        "User-Agent": QUARK_UA,
        "Referer": REFERER,
        "Origin": "https://pan.quark.cn",
    }


def _as_int(value: Any) -> int:
    """接口里的数字有时是字符串、有时干脆缺字段 —— 别让 int() 抛错把整棵树弄崩"""
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def quark_pwd_id(url: str) -> str:
    """从 `https://pan.quark.cn/s/<pwd_id>` 里取分享 ID"""
    m = re.search(r"/s/([0-9a-zA-Z_-]+)", url or "")
    return m.group(1) if m else ""


def quark_passcode(url: str) -> str:
    """链接自带提取码时取出来（`?pwd=abcd` / `#abcd` / 「提取码：abcd」）。

    合并成「网盘下载」之后只有一个输入框，用户是整段粘贴的：
    提取码放在链接里是常态，让用户再往第二个框里抄一遍纯属多余。
    """
    text = url or ""
    m = re.search(r"[?&#](?:pwd|passcode|code)=([0-9A-Za-z]{4,8})", text)
    if m:
        return m.group(1)
    m = re.search(r"(?:提取码|密码|口令)\s*[:：]?\s*([0-9A-Za-z]{4,8})", text)
    return m.group(1) if m else ""


class QuarkAdapter:
    """夸克网盘：解析分享 → 列目录 → 取直链"""

    name = "夸克网盘"
    session = "quark"
    root_id = "0"           # 夸克的根目录 id 是 "0"（迅雷是空字符串）
    anonymous_hint = "未登录（只能下 ~50MB 以内的文件）"
    parse_hint = "正在解析（夸克网盘）…"
    example_host = "pan.quark.cn"

    # 免登录能列的目录、能下的文件大小上限（实测 38.6MB 可 / 68.6MB 被拒，阈值约 50MB）
    anonymous_size_limit = 50 * 1024 * 1024

    # 展开目录时可以同层并发：列目录是只读 GET，`Client` 的 cookie jar 自带锁，
    # 并发几次没有问题（并发数由界面的「展开并发」控制，默认 6）。
    parallel_expand = True

    def __init__(self) -> None:
        self.client = Client("quark", ua=QUARK_UA)

    # ── 配置 ──
    def configure(self, cfg: dict[str, Any]) -> None:  # noqa: ARG002
        """夸克没有可配项（登录态走 Cookie，由界面直接灌进 client）。

        合并成「网盘下载」之后，界面统一对所有适配器调一次 `configure(cfg)`，
        所以这里留一个空实现，而不是到处 `getattr(adapter, "configure", None)`。
        """

    # ── 识别 ──

    @staticmethod
    def match(url: str) -> bool:
        host = urllib.parse.urlparse(url or "").hostname or ""
        return bool(re.search(r"(^|\.)quark\.cn$", host, re.I))

    @property
    def logged_in(self) -> bool:
        """有没有登录态。夸克靠 `__puus` 判定（`_UP_*` 系列是等价旁证）"""
        names = set(self.client.cookie_names())
        return "__puus" in names or any(n.startswith("_UP_") for n in names)

    # ── 解析 ──

    def parse(self, url: str, pwd: str = "") -> tuple[ShareCtx, list[FileEntry], str]:
        pwd_id = quark_pwd_id(url)
        if not pwd_id:
            raise NetdiskError("没能从链接里认出分享 ID（形如 https://pan.quark.cn/s/xxxx）")
        pwd = (pwd or quark_passcode(url)).strip()

        resp = self.client.post_json(
            f"{API}/1/clouddrive/share/sharepage/token?pr=ucpro&fr=pc&uc_param_str=",
            {"pwd_id": pwd_id, "passcode": pwd or ""},
            headers=_headers(),
        )
        data = resp.json()
        if data is None:
            raise NetdiskError(f"夸克返回了非 JSON 内容（HTTP {resp.status}）")
        if resp.status == 404 or data.get("code") == 41006:
            raise NetdiskError("分享不存在或已被删除（请检查链接）")
        if data.get("code") != 0:
            raise NetdiskError(f"夸克解析失败：{self._explain(data)}")

        ctx = ShareCtx(self)
        ctx["pwd_id"] = pwd_id
        ctx["stoken"] = (data.get("data") or {}).get("stoken") or ""
        ctx["title"] = (data.get("data") or {}).get("title") or ""
        ctx["url"] = url
        ctx["pwd"] = pwd
        if not ctx["stoken"]:
            raise NetdiskError("夸克没有返回分享会话（stoken），可能是接口有变")

        entries = self.list_dir(ctx, "0")
        return ctx, entries, str(ctx["title"])

    # ── 列目录 ──

    # 夸克一次最多给 200 项（`_size`），装不下要翻页。
    # 从前只取第 1 页：一个装 300 个文件的目录会**静默少下 100 个**，
    # 用户看到的是"下完了"，实际缺文件 —— 和"层数超过 6 下不了"是一类问题。
    PAGE_SIZE = 100
    MAX_PAGES = 50          # 保险丝：单目录最多 1 万项（再多就说明这不是"目录"了）

    def list_dir(self, ctx: ShareCtx, dir_id: str = "0") -> list[FileEntry]:
        out: list[FileEntry] = []
        for page in range(1, self.MAX_PAGES + 1):
            data = self._detail_page(ctx, dir_id, page)
            payload = data.get("data") or {}
            items = payload.get("list") or []

            for raw in items:
                out.append(
                    FileEntry(
                        id=str(raw.get("fid")),
                        name=str(raw.get("file_name") or "未命名"),
                        size=_as_int(raw.get("size")),
                        is_dir=raw.get("dir") is True,
                        updated_at=_as_int(raw.get("updated_at")),
                        extra={"share_fid_token": raw.get("share_fid_token")},
                    )
                )

            meta = payload.get("metadata") or {}
            total = _as_int(meta.get("_total"))
            page_size = _as_int(meta.get("_size")) or self.PAGE_SIZE
            has_more = data.get("has_more")

            if has_more is False:                      # 服务端明说没有了
                break
            if total and len(out) >= total:           # 数量对上了
                break
            if not items:                             # 空页：再翻也是空的
                break
            if has_more is not True and len(items) < page_size:
                break                                 # 没满一页 = 最后一页
        return out

    def _detail_page(self, ctx: ShareCtx, dir_id: str, page: int) -> dict[str, Any]:
        query = urllib.parse.urlencode(
            {
                "pr": "ucpro",
                "fr": "pc",
                "uc_param_str": "",
                "pwd_id": ctx["pwd_id"],
                "stoken": ctx["stoken"],
                "pdir_fid": dir_id,
                "force": "0",
                "_page": str(page),
                "_size": str(self.PAGE_SIZE),
                "_fetch_banner": "1",
                "_fetch_share": "1",
                "_fetch_total": "1",
                "_sort": "file_type:asc,updated_at:desc",
            }
        )
        resp = self.client.get(
            f"{API}/1/clouddrive/share/sharepage/detail?{query}", headers=_headers()
        )
        data = resp.json()
        if data is None:
            raise NetdiskError(f"夸克返回了非 JSON 内容（HTTP {resp.status}）")
        if resp.status == 401 or data.get("code") == 401:
            raise NetdiskError("登录态已失效，请在设置里重新粘贴夸克 Cookie")
        if data.get("code") != 0:
            # 提取码错误是在这一步才暴露的（token 那步不报错）
            raise NetdiskError(f"夸克列目录失败：{self._explain(data)}")
        return data

    # ── 取直链 ──

    def resolve(self, ctx: ShareCtx, entry: FileEntry) -> tuple[str, dict[str, str]]:
        """取下载直链。返回 (url, 下载时要带的请求头)"""
        # 路线 B（默认）：免转存 —— 不往用户网盘写任何东西
        url = self._download_url_nosave(ctx, entry)
        if url:
            return url, dict(DOWNLOAD_HEADERS)

        # 路线 A（兜底）：转存到自己网盘再取直链
        url = self._download_url_via_save(ctx, entry)
        if url:
            return url, dict(DOWNLOAD_HEADERS)
        raise NetdiskError("夸克没有返回下载直链（接口可能有变）")

    def _download_url_nosave(self, ctx: ShareCtx, entry: FileEntry) -> str:
        resp = self.client.post_json(
            f"{API}/1/clouddrive/file/download?pr=ucpro&fr=pc&uc_param_str=",
            {
                "fids": [entry.id],
                "fids_token": [entry.extra.get("share_fid_token") or ""],
                "pwd_id": ctx["pwd_id"],
                "stoken": ctx["stoken"],
            },
            headers=_headers(),
        )
        data = resp.json()
        if data is None:
            return ""
        if resp.status == 412 or data.get("code") == 412:
            raise NetdiskError(
                "夸克拒绝了直链请求（412）：直链必须带上取链时那份会话 Cookie。请重新解析该分享。"
            )
        code = data.get("code")
        if code == 23018:
            size = entry.size or 0
            raise NetdiskError(
                "夸克限制：未登录时只能取到约 50MB 以下文件的直链"
                f"（这个文件 {size / 1024 / 1024:.1f} MB，错误码 23018）。\n"
                "请在「设置 → 夸克登录」粘贴 Cookie 后再下 —— 登录后同一路径可直接下载 GB 级文件，"
                "而且速度能靠多连接提上去。"
            )
        if code == 401:
            raise NetdiskError("需要登录：请粘贴夸克 Cookie（至少含 __puus）")
        if code != 0:
            return ""
        items = data.get("data") or []
        if items and isinstance(items, list):
            return str(items[0].get("download_url") or "")
        return ""

    def _download_url_via_save(self, ctx: ShareCtx, entry: FileEntry) -> str:
        """兜底：转存到根目录 → 轮询任务 → 用新 fid 取直链（会占用网盘空间）"""
        if not self.logged_in:
            return ""
        resp = self.client.post_json(
            f"{API}/1/clouddrive/share/sharepage/save?pr=ucpro&fr=pc&uc_param_str=",
            {
                "fid_list": [entry.id],
                "fid_token_list": [entry.extra.get("share_fid_token") or ""],
                "to_pdir_fid": "0",
                "pwd_id": ctx["pwd_id"],
                "stoken": ctx["stoken"],
                "pdir_fid": "0",
                "scene": "link",
                "operation": "save",
            },
            headers=_headers(),
        )
        data = resp.json() or {}
        if data.get("code") == 32003:
            raise NetdiskError("转存失败：网盘空间不足，请清理后再试（或开会员扩容）")
        if data.get("code") != 0:
            return ""
        task_id = (data.get("data") or {}).get("task_id")
        if not task_id:
            return ""

        new_fid = ""
        for _ in range(40):
            time.sleep(0.5)
            t = self.client.get(
                f"{API}/1/clouddrive/task?pr=ucpro&fr=pc&uc_param_str="
                f"&task_id={urllib.parse.quote(str(task_id))}&retry_index=0",
                headers=_headers(),
            ).json() or {}
            status = (t.get("data") or {}).get("status")
            if status == 2:
                save_as = (t.get("data") or {}).get("save_as") or {}
                fids = save_as.get("save_as_top_fids") or []
                new_fid = str(fids[0]) if fids else ""
                break
            if status == 3:
                raise NetdiskError("夸克转存任务失败（空间不足或转存过频被风控）")
        if not new_fid:
            return ""

        resp = self.client.post_json(
            f"{API}/1/clouddrive/file/download?pr=ucpro&fr=pc&sys=win32&ve=2.5.56",
            {"fids": [new_fid]},
            headers=_headers(),
        )
        data = resp.json() or {}
        items = data.get("data") or []
        if items and isinstance(items, list):
            return str(items[0].get("download_url") or "")
        return ""

    # ── 工具 ──

    @staticmethod
    def _explain(data: dict[str, Any]) -> str:
        code = data.get("code")
        if code in CODE_HINTS:
            return CODE_HINTS[code]
        msg = data.get("message") or data.get("msg")
        return str(msg) if msg else f"错误码 {code}"
