"""网盘下载器 —— 核心：HTTP 客户端与数据模型

只用标准库（urllib + http.cookiejar），**不需要 pip 安装任何东西**。
这是把它做成独立软件的最大好处之一：双击就能跑，不挑环境。

与 Tauri 插件版的关系：插件跑在 WebView 里，受应用 CSP 限制（既不能 fetch
网盘接口也没有写文件能力），所以那份实现必须把传输和下载都放到 Rust 侧。
独立软件没有这些限制，一切都可以在进程内直接做完 —— 也因此能自己处理
"直链过期了自动换链"，不需要谁来轮询驱动。

例外是**迅雷**：它的分享接口要求 `captcha_sign`，只能在网页上下文里发请求，
所以那家走 `bridge_worker.py`（pywebview 子进程）。夸克仍然是纯标准库。
"""

from __future__ import annotations

import gzip
import http.cookiejar
import io
import json
import os
import socket
import urllib.error
import urllib.parse
import urllib.request
import zlib
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# 默认浏览器 UA
DEFAULT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

# 夸克网盘 PC 客户端 UA。
# **取直链与下载必须用同一个**：夸克 CDN 会校验两处身份是否一致，
# 取链用客户端 UA、下载却换成浏览器 UA，会被判盗链而降速甚至 412。
QUARK_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) quark-cloud-drive/3.14.2 Chrome/112.0.5615.165 "
    "Electron/24.1.3.8 Safari/537.36 Channel/pckk_other_ch"
)

# 迅雷直链用普通浏览器 UA 即可，但**必须带 Referer**（否则 CDN 判盗链 403）。
# 这两个值会一起塞进下载任务的 headers 里，见 xunlei.download_headers()。
XUNLEI_UA = DEFAULT_UA
XUNLEI_REFERER = "https://pan.xunlei.com/"


class NetdiskError(Exception):
    """面向用户的错误：消息会直接显示在界面上"""


@dataclass
class Response:
    status: int
    url: str
    headers: dict[str, str]
    body: bytes

    @property
    def text(self) -> str:
        return self.body.decode("utf-8", "replace")

    def json(self) -> Any:
        try:
            return json.loads(self.text)
        except Exception:
            return None


@dataclass
class FileEntry:
    """分享里的一个条目"""

    id: str
    name: str
    size: int = 0
    is_dir: bool = False
    updated_at: int = 0
    extra: dict[str, Any] = field(default_factory=dict)

    @property
    def size_text(self) -> str:
        return "文件夹" if self.is_dir else human_size(self.size)


@dataclass
class ShareCtx:
    """解析一次分享后的上下文（取直链要用）"""

    adapter: Any = None
    data: dict[str, Any] = field(default_factory=dict)

    def get(self, key: str, default: Any = None) -> Any:
        return self.data.get(key, default)

    # 回归：这里原来**只有 `__setitem__`、没有 `__getitem__`**。
    # 于是 `ctx["pwd_id"] = x`（写）一切正常，`ctx["stoken"]`（读）直接抛
    # `TypeError: 'ShareCtx' object is not subscriptable` —— 适配器里两种写法都用，
    # 结果是**解析分享的第一步就炸**，用户看到的是
    # `解析失败: TypeError: 'ShareCtx' object is not subscriptable`。
    # 之所以一直没被发现：下载引擎的冒烟测试（tools/smoke_download.py）不经过任何
    # 适配器代码，而现在 tools/smoke_adapter.py 把这一整条链盖住了。
    def __getitem__(self, key: str) -> Any:
        return self.data[key]

    def __setitem__(self, key: str, value: Any) -> None:
        self.data[key] = value

    def __contains__(self, key: object) -> bool:
        return key in self.data


def human_size(n: int) -> str:
    if not n or n < 0:
        return "—"
    units = ["B", "KB", "MB", "GB", "TB"]
    v = float(n)
    i = 0
    while v >= 1024 and i < len(units) - 1:
        v /= 1024
        i += 1
    return f"{v:.1f} {units[i]}" if v < 10 and i > 0 else f"{round(v)} {units[i]}"


def human_speed(n: float) -> str:
    return f"{human_size(int(n))}/s" if n > 0 else "—"


class Client:
    """带 cookie jar 的 HTTP 客户端。

    每个网盘一个实例，会话互不干扰 —— 这一点很重要：夸克的匿名会话 cookie
    （`__sdid` 等）和直链是绑定的，不能和别的网盘混在一起。
    """

    def __init__(self, name: str, ua: str = DEFAULT_UA) -> None:
        self.name = name
        self.ua = ua
        self.jar = http.cookiejar.CookieJar()
        # 允许自动 gzip/deflate：urllib 不会自己解压，见 _decode
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.jar)
        )

    # ── 请求 ──

    def request(
        self,
        url: str,
        method: str = "GET",
        headers: dict[str, str] | None = None,
        body: bytes | str | None = None,
        timeout: float = 20.0,
    ) -> Response:
        if isinstance(body, str):
            body = body.encode("utf-8")
        req = urllib.request.Request(url, data=body, method=method)
        req.add_header("User-Agent", self.ua)
        req.add_header("Accept-Encoding", "gzip, deflate")
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        try:
            with self.opener.open(req, timeout=timeout) as resp:
                raw = resp.read()
                return Response(
                    status=resp.status,
                    url=resp.geturl(),
                    headers={k.lower(): v for k, v in resp.headers.items()},
                    body=_decode(raw, resp.headers.get("Content-Encoding", "")),
                )
        except urllib.error.HTTPError as e:
            # HTTP 错误也带响应体（网盘的业务错误码就在里面），不能直接丢
            raw = e.read()
            return Response(
                status=e.code,
                url=url,
                headers={k.lower(): v for k, v in (e.headers or {}).items()},
                body=_decode(raw, (e.headers or {}).get("Content-Encoding", "")),
            )
        except socket.timeout as e:
            raise NetdiskError(f"请求超时：{url.split('?')[0]}") from e
        except urllib.error.URLError as e:
            raise NetdiskError(f"网络错误：{e.reason}") from e

    def get(self, url: str, **kw: Any) -> Response:
        return self.request(url, "GET", **kw)

    def post_json(self, url: str, payload: dict[str, Any], **kw: Any) -> Response:
        headers = dict(kw.pop("headers", {}) or {})
        headers["Content-Type"] = "application/json"
        return self.request(url, "POST", headers=headers, body=json.dumps(payload), **kw)

    def post_form(self, url: str, fields: dict[str, str], **kw: Any) -> Response:
        headers = dict(kw.pop("headers", {}) or {})
        headers["Content-Type"] = "application/x-www-form-urlencoded"
        return self.request(url, "POST", headers=headers, body=urllib.parse.urlencode(fields), **kw)

    # ── Cookie ──

    def import_cookies(self, raw: str) -> int:
        """导入用户从浏览器复制的 Cookie 串（`a=1; b=2`）。

        只收这个网盘域下的：实测把浏览器**全部** Cookie（约 7.2KB）一起发过去，
        服务端会直接掐断连接（IncompleteRead / ChunkedEncodingError）。
        """
        count = 0
        for piece in raw.split(";"):
            piece = piece.strip()
            if not piece or "=" not in piece:
                continue
            name, _, value = piece.partition("=")
            name, value = name.strip(), value.strip().strip('"')
            if not name or not value:
                continue
            self._set_cookie(name, value)
            count += 1
        return count

    def _set_cookie(self, name: str, value: str) -> None:
        cookie = http.cookiejar.Cookie(
            version=0,
            name=name,
            value=value,
            port=None,
            port_specified=False,
            domain="",
            domain_specified=False,
            domain_initial_dot=False,
            path="/",
            path_specified=True,
            secure=True,
            expires=None,
            discard=False,
            comment=None,
            comment_url=None,
            rest={},
        )
        self.jar.set_cookie(cookie)

    def cookie_names(self) -> list[str]:
        return sorted({c.name for c in self.jar})

    def export_cookies(self) -> str:
        return "; ".join(f"{c.name}={c.value}" for c in self.jar)

    def clear_cookies(self) -> None:
        self.jar.clear()


def _decode(raw: bytes, encoding: str) -> bytes:
    """urllib 不会自动解压，这里手动解 —— 网盘接口普遍会 gzip"""
    enc = (encoding or "").lower()
    try:
        if "gzip" in enc:
            return gzip.decompress(raw)
        if "deflate" in enc:
            try:
                return zlib.decompress(raw)
            except zlib.error:
                return zlib.decompress(raw, -zlib.MAX_WBITS)
    except Exception:
        return raw
    return raw


def stream_read(resp: Any, size: int = 256 * 1024):
    """按块读取响应体（下载用）"""
    while True:
        chunk = resp.read(size)
        if not chunk:
            return
        yield chunk


def open_stream(
    client: Client,
    url: str,
    headers: dict[str, str] | None = None,
    byte_range: tuple[int, int] | None = None,
    timeout: float = 20.0,
):
    """打开一个流式响应（下载分片用），返回 (response, 关闭函数)

    这里不走 `Client.request`，因为那个会把整个 body 读进内存 ——
    下载要靠 `resp.read()` 分块拉。
    """
    hdrs = dict(headers or {})
    hdrs.setdefault("User-Agent", client.ua)
    if byte_range is not None:
        hdrs["Range"] = f"bytes={byte_range[0]}-{byte_range[1]}"
    req = urllib.request.Request(url, headers=hdrs, method="GET")
    try:
        resp = client.opener.open(req, timeout=timeout)
    except urllib.error.HTTPError as e:
        # 让调用方看到状态码，好决定是"换链"还是"退避"
        raise HttpStatusError(e.code, url) from e
    except socket.timeout as e:
        raise TimeoutError(str(e)) from e
    return resp


class HttpStatusError(Exception):
    """下载分片请求返回了非 2xx"""

    def __init__(self, status: int, url: str) -> None:
        super().__init__(f"HTTP {status}")
        self.status = status
        self.url = url


# ---------------------------------------------------------------------------
# 落盘路径：Windows 长路径
# ---------------------------------------------------------------------------
# 分享里的深层目录（`课程/第 1 章/第 1 节/素材/配图/原图/xxx.png`）+ 中文文件名，
# 十几层就能撞上 Win32 的 MAX_PATH=260。撞上之后 `mkdir` / `open` 报的是
#   WinError 206 文件名或扩展名太长 / WinError 3 找不到路径
# —— 看起来是"下载失败"，其实是路径被系统截断了。
#
# `\\?\` 前缀让 Win32 API 跳过长度检查（进程必须用宽字符 API，CPython 一直都是），
# **不需要**改注册表里的 `LongPathsEnabled`，也不需要用户做任何设置。
# 代价：这种路径必须是绝对路径、必须是反斜杠、且不能再有 `.` / `..` ——
# 前缀会关掉路径归一化，所以下面统一先 `abspath`。
#
# 只在真的长的时候加前缀（而不是无脑全加）：短路径保持原样，
# `explorer` 之类的 shell 调用看到的就是普通路径。
LONG_PATH_THRESHOLD = 240


def fs_path(path: "os.PathLike[str] | str") -> str:
    r"""把路径换成"系统真的能用"的字符串形式（Windows 长路径自动加 `\\?\`）。"""
    raw = os.fspath(path)
    if os.name != "nt" or raw.startswith("\\\\?\\"):
        return raw
    if len(raw) < LONG_PATH_THRESHOLD:
        return raw
    absolute = os.path.abspath(raw)
    if absolute.startswith("\\\\"):
        # UNC：\\server\share\x → \\?\UNC\server\share\x
        return "\\\\?\\UNC" + absolute[1:]
    return "\\\\?\\" + absolute


def ensure_dir(path: "os.PathLike[str] | str") -> str:
    """建目录（含父级），长路径也能建。返回它转成系统形式后的字符串。"""
    target = fs_path(path)
    os.makedirs(target, exist_ok=True)
    return target


def path_exists(path: "os.PathLike[str] | str") -> bool:
    return os.path.exists(fs_path(path))


# ---------------------------------------------------------------------------
# 版本号
# ---------------------------------------------------------------------------
# 唯一事实源是程序目录下的 `VERSION` 文件（纯文本一行）。为什么不写死在代码里：
#
# 1. 宿主（Rust）要靠它判断"插件包自带的程序"和"随安装包的程序"哪个版本，
#    读文件比启动一次 Python 便宜得多；
# 2. 打包脚本（`scripts/pack-plugin.mjs`）会把 `VERSION` 和插件 manifest 里声明的
#    `companion.version` 比对，不一致直接拒绝出包 —— 版本号想撒谎都难。
VERSION_FILE = Path(__file__).resolve().parent.parent / "VERSION"
_UNKNOWN_VERSION = "0.0.0"


def app_version() -> str:
    """程序版本（读不到就返回 0.0.0，绝不因为版本文件丢了就起不来）"""
    try:
        text = VERSION_FILE.read_text("utf-8").strip()
    except OSError:
        return _UNKNOWN_VERSION
    return text or _UNKNOWN_VERSION


# ---------------------------------------------------------------------------
# 时间：各种形状的"过期时间"
# ---------------------------------------------------------------------------
def epoch_seconds(value: Any) -> float:
    """把"过期时间"的任何写法换成 epoch 秒；认不出来返回 0（= 不知道）。

    三种形态都真实出现过：

    - **数字**：续期接口给 `expires_in`，我们自己是 `time.time() + expires_in` 算出来的；
    - **数字字符串**：接口有时把数字写成 `"1793512539"`；
    - **ISO 8601**：迅雷网页版的 localStorage 里就存着
      `2026-10-31T19:15:39.367Z` 这种字符串。

    以前这里统一用 `float()`，撞上 ISO 就是
    `ValueError: could not convert string to float: '2026-10-31T19:15:39.367Z'`
    —— 发生在"转存前先看要不要续期"那一步，于是整单转存直接失败，
    用户看到的是"部分文件没能开始下载"（跟时间毫无关系的错觉）。

    认不出来时返回 0 而不是抛错：调用方的语义本来就是"0 = 不知道什么时候过期，
    那就等到真撞上 401 再续"。
    """
    if value is None or isinstance(value, bool):
        return 0.0
    if isinstance(value, (int, float)):
        number = float(value)
    else:
        text = str(value).strip()
        if not text:
            return 0.0
        try:
            number = float(text)
        except ValueError:
            return _iso_seconds(text)
    if number <= 0:
        return 0.0
    # 毫秒时间戳（前端偶尔会存 13 位）
    if number > 1e12:
        number /= 1000.0
    return number


def _iso_seconds(text: str) -> float:
    raw = text.strip()
    if raw[-1:] in ("Z", "z"):          # Python 3.10 的 fromisoformat 还不认 Z
        raw = raw[:-1] + "+00:00"
    try:
        moment = datetime.fromisoformat(raw)
    except ValueError:
        return 0.0
    if moment.tzinfo is None:           # 没写时区：网盘接口一律是 UTC
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.timestamp()
