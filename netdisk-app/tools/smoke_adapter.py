"""夸克适配器冒烟测试（离线：不需要账号，也不碰真实网络）

这个脚本是为一个真实故障写的回归：

    `ShareCtx` 一开始只有 `__setitem__`、没有 `__getitem__`。于是适配器里
    `ctx["pwd_id"] = ...`（写）一切正常，`ctx["stoken"]`（读）直接抛
    `TypeError: 'ShareCtx' object is not subscriptable` ——
    用户点「解析」看到的就是 `解析失败: TypeError: 'ShareCtx' object is not subscriptable`。

为什么 `smoke_download.py` 没抓到：它测的是**下载引擎**，起本地 HTTP 服务跑分片，
**一个协议函数都不经过**（`parse` / `list_dir` / `resolve` 全没进去）。所以
"适配器代码根本跑不起来"这种错，在那边是盲区。

这里补上这一段：用假的 HTTP 客户端喂**真实形状**的响应（形状来自
`tools/probe_quark.py` 对真实接口的探测记录），把 parse → list_dir → resolve
整条链跑一遍，一个真实请求都不发，可离线跑、可反复跑。

用法：python tools/smoke_adapter.py
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any, Callable

# 别在源码树里留 __pycache__（main.py 里同理）：自测工具不该污染仓库
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from netdisk.adapters import REFERER, QuarkAdapter, quark_pwd_id  # noqa: E402
from netdisk.core import QUARK_UA, NetdiskError  # noqa: E402


def safe_stdout() -> None:
    """Windows 控制台默认是 GBK，非 GBK 字符会让 print 抛 UnicodeEncodeError。

    这不是小事：**跑完的测试结果会被最后一行打印毁掉**，退出码变成 1，
    看起来像"测试失败"。所以既不使用 emoji，也把编码错误降级掉 ——
    别让打印影响结论。（smoke_download.py 踩过同一个坑，一并修了。）
    """
    try:
        sys.stdout.reconfigure(errors="replace")  # type: ignore[union-attr]
    except Exception:
        pass

# 用一个假分享 ID：测试不该依赖任何人真实的分享链接
SHARE_URL = "https://pan.quark.cn/s/abc123def#/list/share"
PWD_ID = "abc123def"


# ── 假客户端：只实现适配器用得到的那几个方法 ──


class FakeResp:
    """适配器只用到 `status` 和 `json()`（真 `Response` 是 dataclass）"""

    def __init__(self, status: int, payload: Any) -> None:
        self.status = status
        self._payload = payload

    def json(self) -> Any:
        return self._payload


class FakeClient:
    """按 URL 片段路由；顺便记下每次请求，好断言"该带的参数带上了" """

    def __init__(self, routes: list[tuple[str, Any]], cookies: tuple[str, ...] = ()) -> None:
        self.routes = list(routes)
        self.cookies = list(cookies)
        self.seen: list[dict[str, Any]] = []

    def _route(self, method: str, url: str, body: Any, headers: Any) -> FakeResp:
        self.seen.append({"method": method, "url": url, "body": body, "headers": headers})
        for frag, resp in self.routes:
            if frag in url:
                return FakeResp(*resp) if isinstance(resp, tuple) else resp
        raise AssertionError(f"没有为 {method} {url} 准备响应")

    def get(self, url: str, headers: Any = None) -> FakeResp:
        return self._route("GET", url, None, headers)

    def post_json(self, url: str, payload: Any, headers: Any = None) -> FakeResp:
        return self._route("POST", url, payload, headers)

    def cookie_names(self) -> list[str]:
        return sorted(self.cookies)


def routes(
    token: Any = None, detail: Any = None, download: Any = None
) -> list[tuple[str, Any]]:
    """三个接口的默认响应。形状照抄夸克真实返回（见 probe_quark.py 的记录）"""
    return [
        (
            "sharepage/token",
            token
            if token is not None
            else (200, {"code": 0, "data": {"stoken": "ST0KEN", "title": "示例分享"}}),
        ),
        (
            "sharepage/detail",
            detail
            if detail is not None
            else (
                200,
                {
                    "code": 0,
                    "data": {
                        "list": [
                            {
                                "fid": "f1",
                                "file_name": "报告.pdf",
                                "size": 12345,
                                "dir": False,
                                "share_fid_token": "ft1",
                                "updated_at": 1700000000,
                            },
                            {
                                "fid": "d1",
                                "file_name": "素材",
                                "size": 0,
                                "dir": True,
                                "share_fid_token": "ft2",
                                "updated_at": 0,
                            },
                        ]
                    },
                },
            ),
        ),
        (
            "file/download",
            download
            if download is not None
            else (200, {"code": 0, "data": [{"download_url": "https://cdn.example.com/x?sign=1"}]}),
        ),
    ]


def make_adapter(rs: list[tuple[str, Any]], cookies: tuple[str, ...] = ()) -> QuarkAdapter:
    """把真客户端换成假的 —— 否则构造 QuarkAdapter 会建 cookie jar 并真的发请求"""
    ad = QuarkAdapter()
    ad.client = FakeClient(rs, cookies)  # type: ignore[assignment]
    return ad


# ── 断言小工具 ──


class Case:
    def __init__(self, name: str, fn: Callable[[], None]) -> None:
        self.name = name
        self.fn = fn


def expect_error(fn: Callable[[], Any], must_contain: str) -> str:
    """要求 fn 抛 NetdiskError 且消息里含某段文字；返回实际消息（供打印）"""
    try:
        fn()
    except NetdiskError as e:
        msg = str(e)
        assert must_contain in msg, f"错误消息里没有「{must_contain}」：{msg}"
        return msg
    except Exception as e:  # noqa: BLE001 —— 别的异常也算案例失败，要看清是什么
        raise AssertionError(f"抛的不是 NetdiskError，而是 {type(e).__name__}: {e}") from e
    raise AssertionError("没有抛任何异常")


# ── 案例 ──


def full_chain() -> None:
    """parse → list_dir → resolve：这条链是用户点「解析」和「下载」时走的"""
    ad = make_adapter(routes())
    ctx, entries, title = ad.parse(SHARE_URL, "")

    assert title == "示例分享", title

    # ↓↓ 就是崩在这里：读 ctx[...] 需要 __getitem__ ↓↓
    assert ctx["pwd_id"] == PWD_ID, ctx["pwd_id"]
    assert ctx["stoken"] == "ST0KEN", ctx["stoken"]
    assert ctx["url"] == SHARE_URL
    # 字典风格和 .get() 风格都要能用（适配器里两种都出现过）
    assert ctx.get("pwd_id") == PWD_ID
    assert ctx.data["stoken"] == "ST0KEN"

    assert [e.name for e in entries] == ["报告.pdf", "素材"]
    assert entries[0].is_dir is False and entries[0].size == 12345
    assert entries[1].is_dir is True and entries[1].size_text == "文件夹"
    assert entries[0].extra["share_fid_token"] == "ft1"

    # 请求体/查询串里该带的身份信息一个都不能少，否则夸克会给 14001
    detail = next(c for c in ad.client.seen if "sharepage/detail" in c["url"])  # type: ignore[attr-defined]
    assert f"pwd_id={PWD_ID}" in detail["url"], detail["url"]
    assert "stoken=ST0KEN" in detail["url"], detail["url"]
    assert detail["headers"]["User-Agent"] == QUARK_UA

    url, headers = ad.resolve(ctx, entries[0])
    assert url == "https://cdn.example.com/x?sign=1", url
    # 取链与下载必须同一个 UA，否则 CDN 判盗链（412）
    assert headers["User-Agent"] == QUARK_UA
    assert headers["Referer"] == REFERER

    dl = next(c for c in ad.client.seen if "file/download" in c["url"])  # type: ignore[attr-defined]
    assert dl["body"]["fids"] == ["f1"], dl["body"]
    assert dl["body"]["fids_token"] == ["ft1"], dl["body"]
    assert dl["body"]["pwd_id"] == PWD_ID and dl["body"]["stoken"] == "ST0KEN"


def subdir_listing() -> None:
    """进子目录时要按 pdir_fid 请求，而不是永远从根列"""
    ad = make_adapter(routes())
    ctx, _, _ = ad.parse(SHARE_URL, "")
    ad.list_dir(ctx, "d1")
    last = [c for c in ad.client.seen if "sharepage/detail" in c["url"]][-1]  # type: ignore[attr-defined]
    assert "pdir_fid=d1" in last["url"], last["url"]


def error_share_gone() -> None:
    ad = make_adapter(routes(token=(404, {"code": 41006, "message": "分享已失效"})))
    expect_error(lambda: ad.parse(SHARE_URL, ""), "分享不存在")


def error_bad_passcode() -> None:
    """提取码是错的：token 那步不报错，detail 那步才暴露"""
    ad = make_adapter(routes(detail=(200, {"code": 41008, "message": "提取码错误"})))
    expect_error(lambda: ad.parse(SHARE_URL, "0000"), "提取码错误")


def error_no_stoken() -> None:
    ad = make_adapter(routes(token=(200, {"code": 0, "data": {}})))
    expect_error(lambda: ad.parse(SHARE_URL, ""), "stoken")


def error_bad_url() -> None:
    ad = make_adapter(routes())
    expect_error(lambda: ad.parse("https://pan.quark.cn/s/", ""), "分享 ID")


def error_anonymous_too_big() -> None:
    """匿名档 50MB 上限：必须给出可操作的建议，而不是一句错误码"""
    ad = make_adapter(routes(download=(200, {"code": 23018, "message": "size limit"})))
    ctx, entries, _ = ad.parse(SHARE_URL, "")
    big = entries[0]
    big.size = 68 * 1024 * 1024
    expect_error(lambda: ad.resolve(ctx, big), "23018")


def error_session_expired() -> None:
    ad = make_adapter(routes(detail=(401, {"code": 401, "message": "unauthorized"})))
    expect_error(lambda: ad.parse(SHARE_URL, ""), "登录态已失效")


def anonymous_cannot_save() -> None:
    """没登录时取链失败 → 不能偷偷走"转存到自己网盘"那条路（会占用户空间）"""
    ad = make_adapter(routes(download=(200, {"code": 0, "data": []})))
    ctx, entries, _ = ad.parse(SHARE_URL, "")
    expect_error(lambda: ad.resolve(ctx, entries[0]), "没有返回下载直链")
    assert not any("sharepage/save" in c["url"] for c in ad.client.seen)  # type: ignore[attr-defined]


def url_recognition() -> None:
    assert quark_pwd_id(SHARE_URL) == PWD_ID
    assert quark_pwd_id("https://pan.quark.cn/s/xyz-9_AB?pwd=1234") == "xyz-9_AB"
    assert quark_pwd_id("https://example.com/s/abc") == "abc"  # 只管形状，域名校验在 match()
    assert quark_pwd_id("") == ""

    assert QuarkAdapter.match(SHARE_URL) is True
    assert QuarkAdapter.match("https://drive.quark.cn/s/abc") is True
    assert QuarkAdapter.match("https://pan.baidu.com/s/abc") is False
    assert QuarkAdapter.match("https://quark.cn.evil.com/s/abc") is False


CASES = [
    Case("完整链路 parse→list_dir→resolve", full_chain),
    Case("子目录按 pdir_fid 请求", subdir_listing),
    Case("分享不存在 → 人话提示", error_share_gone),
    Case("提取码错误（detail 步才暴露）", error_bad_passcode),
    Case("没有 stoken → 提示接口可能变了", error_no_stoken),
    Case("链接里没有分享 ID", error_bad_url),
    Case("匿名 50MB 上限 → 给出登录建议", error_anonymous_too_big),
    Case("登录态失效", error_session_expired),
    Case("匿名取链失败不偷偷转存", anonymous_cannot_save),
    Case("链接识别与域名匹配", url_recognition),
]


def main() -> int:
    safe_stdout()
    failures = 0
    for i, case in enumerate(CASES, 1):
        try:
            case.fn()
        except Exception as e:  # noqa: BLE001
            failures += 1
            print(f"[{i}] {case.name} → FAIL：{type(e).__name__}: {e}")
        else:
            print(f"[{i}] {case.name} → OK")

    print("\n全部通过" if failures == 0 else f"\n{failures} 项失败")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
