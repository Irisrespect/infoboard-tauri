"""网盘下载器 —— 核心：HTTP 客户端与数据模型

只用标准库（urllib + http.cookiejar），**不需要 pip 安装任何东西**。
这是把它做成独立软件的最大好处之一：双击就能跑，不挑环境。

与 Tauri 插件版的关系：插件跑在 WebView 里，受应用 CSP 限制（既不能 fetch
网盘接口也没有写文件能力），所以那份实现必须把传输和下载都放到 Rust 侧。
独立软件没有这些限制，一切都可以在进程内直接做完 —— 也因此能自己处理
"直链过期了自动换链"，不需要谁来轮询驱动。
"""

from __future__ import annotations

import gzip
import http.cookiejar
import io
import json
import socket
import urllib.error
import urllib.parse
import urllib.request
import zlib
from dataclasses import dataclass, field
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

    def __setitem__(self, key: str, value: Any) -> None:
        self.data[key] = value


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
