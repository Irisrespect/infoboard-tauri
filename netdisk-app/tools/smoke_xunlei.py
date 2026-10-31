"""迅雷适配器冒烟测试（离线：不联网、不开 WebView、不需要账号）

为什么单独一个脚本：`smoke_adapter.py` 测的是夸克那条链，而迅雷的**协议请求全在
另一个进程里**（`bridge_worker.py`，因为它必须借网页算 captcha）。所以这里把
`XunleiAdapter._run` 换成一个假的 runner，喂**真实形状**的响应，把

    parse → 面包屑 list_dir → resolve（直接有链）→ prefetch（转存取链）→ 报错路径

整条链跑一遍。同时顺带验证 JS 模板能正确拼装 —— 那是另一个只在真机才会炸的坑：

    JS 模板里到处是 `%`（encodeURIComponent、CSS 字符串）。上一版用 `%` 格式化，
    只要多加一行样式就是 ValueError: unsupported format character。现在用
    `__占位符__` + str.replace，这里把四种模板都填一遍，确保没有漏掉的占位符。

用法：python tools/smoke_xunlei.py
"""

from __future__ import annotations

import base64
import json
import re
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from netdisk import bridge_worker  # noqa: E402
from netdisk import xunlei as xunlei_mod  # noqa: E402
from netdisk.core import XUNLEI_REFERER, NetdiskError, epoch_seconds  # noqa: E402
from netdisk.xunlei import XunleiAdapter, parse_share_url, swap_mirror  # noqa: E402

SHARE_URL = "https://pan.xunlei.com/s/VExampleShareId123?pwd=ab12"
SHARE_ID = "VExampleShareId123"
PWD = "ab12"


def safe_stdout() -> None:
    try:
        sys.stdout.reconfigure(errors="replace")  # type: ignore[union-attr]
    except Exception:
        pass


# ── 假的 bridge：按 mode 返回固定形状（形状照抄真机 dump 的结构）──
class FakeBridge:
    """记录每次调用，方便断言"转存是不是批量做的"、"cleanup 有没有传对"。

    `restore_data=None` 时按**请求的 id** 现造结果 —— 这样"过期换链"那种
    "同一个文件再取一次"的路径也能走通（写死一份响应会漏掉这类流程）。
    """

    def __init__(
        self,
        resolve: dict | None = None,
        restore: dict | None = None,
        restore_error: str | None = None,
    ) -> None:
        self.calls: list[tuple[str, dict]] = []
        self.resolve_data = resolve if resolve is not None else DEFAULT_RESOLVE
        self.restore_data = restore
        self.restore_error = restore_error

    def __call__(self, mode: str, **kw) -> dict:
        self.calls.append((mode, kw))
        if mode == "resolve":
            return self.resolve_data
        if mode == "refresh":
            return {
                "state": "done",
                "refreshed": True,
                "logged_in": True,
                "reason": "已自动续期",
                "expires_at": time.time() + 7200,
            }
        if mode == "restore":
            if self.restore_error is not None:
                # 真 bridge_run 在 state=error 时抛的就是这个（消息原样透传）
                raise NetdiskError(self.restore_error)
            if self.restore_data is not None:
                return self.restore_data
            return {
                "state": "done",
                "results": [
                    {
                        "source_id": fid,
                        "restored_id": f"n_{fid}",
                        "link": f"https://vod3379-aliyun04-vip-lixian.xunlei.com/{fid}?sign=2",
                        "deleted": True,
                    }
                    for fid in kw.get("ids") or []
                ],
                "map": {fid: f"n_{fid}" for fid in kw.get("ids") or []},
            }
        if mode == "login":
            return {"state": "done", "user_id": "42"}
        if mode == "status":
            return {"state": "done", "logged_in": True, "user_id": "42"}
        raise AssertionError(f"没准备好的模式: {mode}")


DEFAULT_RESOLVE = {
    "state": "done",
    "title": "示例分享",
    "pass_code_token": "PCT",
    "files": [
        {
            "id": "f1",
            "name": "小文件.txt",
            "kind": "drive#file",
            "size": 1024,
            "link": "https://vod0007-h05-vip-lixian.xunlei.com/a?sign=1",
            "children": [],
        },
        {
            "id": "d1",
            "name": "素材",
            "kind": "drive#folder",
            "size": 0,
            "link": "",
            "children": [
                {
                    "id": "f2",
                    "name": "大文件.mkv",
                    "kind": "drive#file",
                    "size": 900 * 1024 * 1024,
                    "link": "",
                    "children": [],
                }
            ],
        },
    ],
}

DEFAULT_RESTORE = {
    "state": "done",
    "results": [
        {
            "source_id": "f2",
            "restored_id": "n2",
            "link": "https://vod3379-aliyun04-vip-lixian.xunlei.com/b?sign=2",
            "name": "大文件.mkv",
            "size": 943718400,
            "deleted": True,
        }
    ],
    "map": {"f2": "n2"},
}


class LoggedInAdapter(XunleiAdapter):
    """把"已登录"钉死成一个子类，而不是去改类的 property —— 改类属性会污染后面所有案例。"""

    @property
    def logged_in(self) -> bool:
        return True


class AnonymousAdapter(XunleiAdapter):
    @property
    def logged_in(self) -> bool:
        return False


def make_adapter(bridge: FakeBridge, logged_in: bool = True) -> XunleiAdapter:
    cls = LoggedInAdapter if logged_in else AnonymousAdapter
    ad = cls(runner=bridge)
    ad.cleanup = True
    return ad


# ── 假的 WebView：只认「读 creds」和「写 creds」两段脚本 ──
class FakeWindow:
    def __init__(self, creds: dict) -> None:
        self.creds = dict(creds)
        self.last_write: str | None = None

    def evaluate_js(self, js: str) -> str:
        if "setItem" in js:
            self.last_write = js
            return "ok"
        if "credentials_" in js and "getItem" in js:
            return json.dumps({
                "access_token": self.creds.get("access_token") or "",
                "refresh_token": self.creds.get("refresh_token") or "",
                "expires_at": self.creds.get("expires_at") or 0,
                "device_id": self.creds.get("device_id") or "",
            })
        return ""


def _jwt(exp: int) -> str:
    """造一个形态逼真的 JWT（真 token 是几百字符，太短的不该被当成 token）。"""
    payload = base64.urlsafe_b64encode(
        json.dumps({"sub": "42", "exp": exp, "pad": "x" * 48}).encode()
    ).decode().rstrip("=")
    return f"eyJhbGciOiJIUzI1NiJ9.{payload}.signature-part"


def _iso(ts: float) -> str:
    """把 epoch 秒写成迅雷网页版那种 ISO（毫秒 + Z）：`2026-10-31T19:15:39.367Z`。"""
    moment = datetime.fromtimestamp(ts, timezone.utc)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"


# ── 案例 ──
def url_parsing() -> None:
    assert parse_share_url(SHARE_URL) == (SHARE_ID, PWD)
    assert parse_share_url(f"{SHARE_ID}") == (SHARE_ID, None)
    assert parse_share_url(f"分享链接：https://pan.xunlei.com/s/{SHARE_ID} 提取码：ab12") == (
        SHARE_ID,
        "ab12",
    )
    # 老式 #abcd 写法：不能把页面路由 `#/list` 误当提取码
    assert parse_share_url("https://pan.xunlei.com/s/VExampleShareId123#ab12") == (
        SHARE_ID,
        "ab12",
    )
    assert parse_share_url("https://pan.xunlei.com/s/VExampleShareId123#/list") == (
        SHARE_ID,
        None,
    )
    try:
        parse_share_url("https://pan.baidu.com/s/1abc")
    except NetdiskError as e:
        assert "没认出" in str(e)
    else:
        raise AssertionError("百度链接应该报错")

    assert XunleiAdapter.match(SHARE_URL) is True
    assert XunleiAdapter.match("https://www.xunlei.com/") is False
    assert XunleiAdapter.match("https://pan.quark.cn/s/abc") is False
    assert XunleiAdapter.match("https://pan.xunlei.com.evil.com/s/abc") is False


def full_chain() -> None:
    bridge = FakeBridge()
    ad = make_adapter(bridge)
    ctx, entries, title = ad.parse(SHARE_URL, "")

    assert title == "示例分享", title
    assert [e.name for e in entries] == ["小文件.txt", "素材"]
    assert entries[1].is_dir is True and entries[1].size_text == "文件夹"
    # 提取码从链接里取出来并传给 worker
    mode, kw = bridge.calls[0]
    assert mode == "resolve" and kw["share_id"] == SHARE_ID and kw["pwd"] == PWD, kw

    # 子目录：解析时就整棵树拿回来了，翻目录不该再调桥
    calls_before = len(bridge.calls)
    sub = ad.list_dir(ctx, "d1")
    assert [e.name for e in sub] == ["大文件.mkv"]
    assert len(bridge.calls) == calls_before, "翻目录不该再开 WebView"

    # 根目录 id 是空串（跟夸克的 "0" 不同），面包屑回到根要用它
    assert ad.root_id == ""

    # 有直链的文件：直接给，且必须带 Referer
    url, headers = ad.resolve(ctx, entries[0])
    assert url.startswith("https://vod0007-h05-vip-lixian.xunlei.com/"), url
    assert headers["Referer"] == XUNLEI_REFERER, headers


def restore_chain() -> None:
    """大文件：一次批量转存拿链；cleanup 设置要透传到 worker。"""
    bridge = FakeBridge()
    ad = make_adapter(bridge)
    ad.cleanup = False
    ctx, entries, _ = ad.parse(SHARE_URL, "")
    big = ad.list_dir(ctx, "d1")[0]

    ad.prefetch(ctx, [entries[0], big])     # 只有大文件缺链，小文件不该被转存
    mode, kw = bridge.calls[-1]
    assert mode == "restore", mode
    assert kw["ids"] == ["f2"], kw["ids"]
    assert kw["cleanup"] is False, kw

    url, _h = ad.resolve(ctx, big)
    assert url.endswith("sign=2"), url
    # 第二次 resolve 用缓存，不该再转存一次
    before = len([c for c in bridge.calls if c[0] == "restore"])
    ad.resolve(ctx, big)
    assert len([c for c in bridge.calls if c[0] == "restore"]) == before


def restore_failure() -> None:
    """转存返回空链 → 必须给"空间满/限流"这种能指导用户的话，而不是一句码"""
    bridge = FakeBridge(restore={"state": "done", "results": [
        {"source_id": "f2", "restored_id": "n2", "link": "", "error": "HTTP 403"}
    ]})
    ad = make_adapter(bridge)
    ctx, _entries, _ = ad.parse(SHARE_URL, "")
    big = ad.list_dir(ctx, "d1")[0]
    try:
        ad.prefetch(ctx, [big])
    except NetdiskError as e:
        assert "空间已满" in str(e), str(e)
    else:
        raise AssertionError("空直链应该报错")


def restore_needs_login() -> None:
    """没登录 + 大文件 → 告诉用户去哪儿登录，而不是开个窗口白等"""
    bridge = FakeBridge()
    ad = make_adapter(bridge, logged_in=False)
    ctx, _entries, _ = ad.parse(SHARE_URL, "")
    big = ad.list_dir(ctx, "d1")[0]

    try:
        ad.prefetch(ctx, [big])
    except NetdiskError as e:
        assert "扫码登录" in str(e), str(e)
    else:
        raise AssertionError("没登录应该报错")

    # 没登录、也没转存过：这个文件拿不到直链 → 必须说清原因
    try:
        ad.resolve(ctx, big)
    except NetdiskError as e:
        assert "扫码登录" in str(e), str(e)
    else:
        raise AssertionError("没登录的大文件不该有直链")

    # 有直链的文件在未登录时照样能下
    url, _h = ad.resolve(ctx, ctx["tree"][""][0])
    assert url.startswith("https://"), url


def invalidate_drops_stale_link() -> None:
    """直链过期后必须丢掉缓存，否则换链回调会把同一条死链再交出去"""
    bridge = FakeBridge()
    ad = make_adapter(bridge)
    ctx, entries, _ = ad.parse(SHARE_URL, "")
    small = entries[0]
    ad.invalidate(ctx, small)
    assert small.id not in ctx["links"]
    # 丢掉之后 resolve 会重新拿（这里 worker 又给了同一条，等价于"刷新成功"）
    url, _h = ad.resolve(ctx, small)
    assert url.startswith("https://"), url


def mirror_swap() -> None:
    link = "https://vod0007-h05-vip-lixian.xunlei.com/path/file?sign=abc"
    swapped = swap_mirror(link, "vod0267-aliyun08-vip-lixian.xunlei.com")
    assert swapped.startswith("https://vod0267-aliyun08-vip-lixian.xunlei.com/path/file"), swapped
    assert swapped.endswith("sign=abc"), swapped


def js_templates_compile() -> None:
    """四个模板都要能填完占位符 —— 漏一个就是 Worker 起来直接 KeyError。"""
    resolve = (
        bridge_worker.JS_RESOLVE.replace("__SHARE_ID__", json.dumps(SHARE_ID))
        .replace("__PASS_CODE__", json.dumps(PWD))
        .replace("__CLIENT_ID__", bridge_worker.CLIENT_ID)
        .replace("__API_BASE__", bridge_worker.API_BASE)
        .replace("__MAX_DEPTH__", str(bridge_worker.MAX_TREE_DEPTH))
    )
    for leftover in (
        "__SHARE_ID__",
        "__PASS_CODE__",
        "__CLIENT_ID__",
        "__API_BASE__",
        "__MAX_DEPTH__",
    ):
        assert leftover not in resolve, f"JS_RESOLVE 里还有没替换的 {leftover}"
    assert "/share/file_info" in resolve and "/share/detail" in resolve

    # 层数上限两边必须一致：JS 里少翻一层，Python 这边就会以为"目录不存在"，
    # 报出来的却是"层级超过 N 层"（旧版写死 6，第 7 层整棵子树缺失）
    assert f"var MAX_DEPTH = {bridge_worker.MAX_TREE_DEPTH};" in resolve
    assert bridge_worker.MAX_TREE_DEPTH == xunlei_mod.MAX_TREE_DEPTH, (
        f"bridge_worker.MAX_TREE_DEPTH={bridge_worker.MAX_TREE_DEPTH} 与 "
        f"xunlei.MAX_TREE_DEPTH={xunlei_mod.MAX_TREE_DEPTH} 不一致"
    )

    restore = (
        bridge_worker.JS_RESTORE.replace("__SHARE_ID__", json.dumps(SHARE_ID))
        .replace("__PASS_CODE__", json.dumps(PWD))
        .replace("__FILE_IDS__", json.dumps(["f2"]))
        .replace("__CLEANUP__", "true")
        .replace("__CLIENT_ID__", bridge_worker.CLIENT_ID)
        .replace("__API_BASE__", bridge_worker.API_BASE)
    )
    for leftover in ("__SHARE_ID__", "__PASS_CODE__", "__FILE_IDS__", "__CLEANUP__"):
        assert leftover not in restore, f"JS_RESTORE 里还有没替换的 {leftover}"
    # 两个反直觉的坑必须还在代码里：
    # 映射藏在 params.trace_file_ids（且是 JSON 字符串）；取云盘直链时只传 space=
    assert "trace_file_ids" in restore
    assert "params: {space: ''}" in restore, "云盘取链必须只传 space="
    assert "usage=" not in restore, "别把 usage=CONSUME 加回请求里（会让直链变空串）"

    for js in (bridge_worker.JS_DUMP, bridge_worker.JS_LOGIN_HINT):
        assert js.strip().startswith("(function"), js[:40]


def login_extract() -> None:
    """登录窗口靠它判断"扫完了没"：从 storage dump 里挑出 access_token。"""
    token = "eyJhbGciOiJIUzI1NiJ9." + "eyJzdWIiOiI0MiIsImV4cCI6NDEwMjQ0NDgwMH0" + ".sig"
    snapshot = json.dumps({
        "href": "https://pan.xunlei.com/",
        "local": {
            "credentials_Xqp0kJBXWhwaTpB6": json.dumps({
                "access_token": token,
                "refresh_token": "refresh-abc-1234567890",
            }),
            "deviceid": "a" * 32,
        },
        "session": {},
    })
    found = bridge_worker.extract_login(snapshot)
    assert found is not None, "应该识别出登录态"
    assert found["access_token"] == token
    assert found["user_id"] == "42"
    assert found["refresh_token"] == "refresh-abc-1234567890"

    # 没登录（页面只有普通字符串）→ None，登录窗口继续等
    assert bridge_worker.extract_login(json.dumps({"local": {"a": "b"}})) is None
    assert bridge_worker.extract_login("not json") is None
    assert bridge_worker.extract_login(None) is None


def stale_marker_is_cleared() -> None:
    """本地标记说"已登录"、服务端说没登录 → 标记必须被清掉，界面不能继续撒谎"""
    with tempfile.TemporaryDirectory() as tmp:
        marker = Path(tmp) / "xunlei_login.json"
        marker.write_text(json.dumps({"user_id": "1"}), "utf-8")
        original = xunlei_mod.LOGIN_MARKER
        xunlei_mod.LOGIN_MARKER = marker
        try:
            bridge = FakeBridge(restore_error="NOT_LOGGED_IN: 转存需要先登录迅雷（设置 → 迅雷 → 扫码登录）")
            ad = make_adapter(bridge)          # 假设标记还在 → logged_in=True
            ctx, _entries, _ = ad.parse(SHARE_URL, "")
            big = ad.list_dir(ctx, "d1")[0]
            try:
                ad.prefetch(ctx, [big])
            except NetdiskError as e:
                assert "扫码登录" in str(e), str(e)
                assert "NOT_LOGGED_IN" not in str(e), "机器用的前缀不该露给用户"
            else:
                raise AssertionError("应该报错")
            assert not marker.exists(), "过期的登录标记应该被清掉"
        finally:
            xunlei_mod.LOGIN_MARKER = original


def legacy_migration() -> None:
    """从旧「迅雷下载器」升级：profile 搬过来 + 补一个"已迁移"标记。

    不补标记的话，升级上来的人会看到"未登录"，于是去重新扫一次码 —— 明明还能用。
    标记只是"登录过"的证据，真过期了下一次转存会报 NOT_LOGGED_IN 并把它清掉。
    """
    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp)
        legacy = base / "legacy" / "webview"
        (legacy / "EBWebView" / "Default" / "Local Storage").mkdir(parents=True)
        (legacy / "EBWebView" / "Default" / "Local Storage" / "000003.log").write_bytes(b"x" * 32)
        (legacy / "EBWebView" / "Cache").mkdir(parents=True)          # 缓存该被忽略
        (legacy / "EBWebView" / "Cache" / "big.bin").write_bytes(b"y" * 64)

        creds = base / "legacy" / "credentials.bin"
        creds.write_bytes(b"\x01\x02")                                  # 旧程序登录过的证据
        marker = base / "xunlei_login.json"
        storage = base / "new" / "webview"

        bridge_worker.prepare_storage(storage, legacy, creds, marker)
        assert (storage / "EBWebView" / "Default" / "Local Storage" / "000003.log").is_file(), \
            "登录态（localStorage）必须搬过来"
        assert not (storage / "EBWebView" / "Cache").exists(), "体积大的缓存不该搬"
        data = json.loads(marker.read_text("utf-8"))
        assert data.get("migrated") is True, data

        # 没登录过的旧程序（没有 credentials.bin）→ 不该补标记
        marker2 = base / "marker2.json"
        storage2 = base / "new2" / "webview"
        bridge_worker.prepare_storage(storage2, legacy, None, marker2)
        assert storage2.exists()
        assert not marker2.exists(), "没登录过就别假装登录过"

        # 新目录已经有东西 → 绝不覆盖（用户可能已经重新登录过）
        existing = storage / "keep.txt"
        existing.write_text("mine", "utf-8")
        bridge_worker.prepare_storage(storage, legacy, creds, marker)
        assert existing.read_text("utf-8") == "mine", "已在用的 profile 不能被覆盖"


def marker_sync() -> None:
    """标记要跟着真实结果走：检查成功写、检查失败删、其它模式不动。"""
    with tempfile.TemporaryDirectory() as tmp:
        marker = Path(tmp) / "xunlei_login.json"

        bridge_worker.sync_marker(marker, "status", {"state": "done", "logged_in": True, "user_id": "7"})
        assert json.loads(marker.read_text("utf-8"))["user_id"] == "7"

        bridge_worker.sync_marker(marker, "status", {"state": "done", "logged_in": False})
        assert not marker.exists(), "检查发现没登录，标记必须删掉"

        # 解析/转存失败不该动标记（那只是这次请求的问题，不代表登录态没了）
        bridge_worker.sync_marker(marker, "restore", {"state": "error", "error": "HTTP 500"})
        assert not marker.exists()
        marker.write_text('{"user_id": "1"}', "utf-8")
        bridge_worker.sync_marker(marker, "resolve", {"state": "error", "error": "x"})
        assert marker.exists(), "解析失败不代表掉登录"

        # 续期（refresh）不该删标记：它失败可能只是这次没续上
        bridge_worker.sync_marker(marker, "refresh", {"state": "done", "refreshed": False,
                                                     "logged_in": False, "reason": "页面里没有登录态"})
        assert marker.exists(), "点一下刷新不该把自己变成未登录"

        # 检查确认没登录 → 删（这条是「检查」的职责）
        bridge_worker.sync_marker(marker, "status", {"state": "done", "logged_in": False})
        assert not marker.exists()

        # 检查本身失败（页面没加载）→ 不删
        marker.write_text('{"user_id": "1"}', "utf-8")
        bridge_worker.sync_marker(marker, "status", {"state": "error", "error": "页面没加载"})
        assert marker.exists(), "断网时点检查不该清掉登录标记"


def error_translation() -> None:
    """页面抛上来的原始 JSON 要翻成人话 —— 直接甩 JSON 等于没说"""
    cases = {
        'HTTP 400 {"error":"invalid_argument","error_code":3,'
        '"error_details":[{"detail":"share_id can not be empty or share_id invalid"}]}': "share_id",
        "HTTP 400 captcha_invalid": "captcha",
        'HTTP 400 {"error":"pass_code_invalid"}': "提取码",
        'HTTP 403 {"detail":"分享不存在"}': "不存在",
        "HTTP 500 oops": "HTTP 500",
    }
    for raw, must_contain in cases.items():
        got = bridge_worker.humanize_error(raw)
        assert must_contain in got, f"{raw} → {got}"
        assert len(got) < 300, got

    # error_description / detail 要被摘出来给用户看
    got = bridge_worker.humanize_error(
        'HTTP 400 {"error":"x","error_description":"请求参数错误"}'
    )
    assert "请求参数错误" in got, got
    # 空错误不能抛异常
    assert isinstance(bridge_worker.humanize_error(""), str)
    # 机器前缀不能在翻译里丢掉（父程序靠它判断要不要清标记）
    got = bridge_worker.humanize_error("NOT_LOGGED_IN: 转存需要先登录迅雷")
    assert "扫码登录" in got, got


def batch_failure_fails_fast() -> None:
    """批量转存失败后，同一次下载里后面的文件不该再各开一次浏览器（10 秒/个）"""
    bridge = FakeBridge(restore_error="转存任务失败：空间不足")
    ad = make_adapter(bridge)
    ctx, entries, _ = ad.parse(SHARE_URL, "")
    big = ad.list_dir(ctx, "d1")[0]

    try:
        ad.prefetch(ctx, [big])
    except NetdiskError as e:
        assert "空间不足" in str(e), str(e)
    else:
        raise AssertionError("应该报错")

    before = len([c for c in bridge.calls if c[0] == "restore"])
    try:
        ad.resolve(ctx, big)
    except NetdiskError as e:
        assert "空间不足" in str(e), str(e)
    else:
        raise AssertionError("应当立刻失败")
    after = len([c for c in bridge.calls if c[0] == "restore"])
    assert after == before, "失败后不该再调用转存"

    # 用户重试（再点一次下载）时，必须允许重新尝试
    bridge.restore_error = None
    ad.prefetch(ctx, [big])
    url, _h = ad.resolve(ctx, big)
    assert url.startswith("https://"), url


def refresh_decision() -> None:
    """什么时候该续：快过期才续；**过期时间未知时不续**（别白白消耗轮换型 refresh_token）"""
    now = 1_000_000.0
    assert bridge_worker.needs_refresh(0, now=now) is False, "不知道过期时间就先别动"
    assert bridge_worker.needs_refresh(now + 10, now=now) is True
    assert bridge_worker.needs_refresh(now + 60, now=now) is True
    assert bridge_worker.needs_refresh(now + 3600, now=now) is False
    assert bridge_worker.needs_refresh(now - 1, now=now) is True
    # 边界：正好卡在 margin 上不算"快过期"
    assert bridge_worker.needs_refresh(now + 600, now=now) is False
    assert bridge_worker.needs_refresh(now + 599, now=now) is True


def refresh_http_parsing() -> None:
    """续期接口的返回形态有几种（token / access_token、expires_in / 无），都要吃得下"""
    seen: dict = {}

    def post_ok(url, payload, headers, timeout):
        seen["url"] = url
        seen["payload"] = payload
        seen["headers"] = headers
        return {"token": "T", "refresh_token": "R2", "expires_in": 3600}

    got = bridge_worker.refresh_access_token("r0", "dev-1", post=post_ok)
    assert got["access_token"] == "T", got
    assert got["refresh_token"] == "R2", got
    assert got["expires_at"] > time.time() + 3000, got
    # 端点是 /v1/auth/token（/auth/refresh 实测 404，别照抄旧代码改回去）
    assert seen["url"].endswith("/v1/auth/token"), seen["url"]
    assert seen["payload"]["grant_type"] == "refresh_token"
    assert seen["payload"]["refresh_token"] == "r0"
    assert seen["headers"]["x-device-id"] == "dev-1"

    # 字段包在 data 里也要认
    got = bridge_worker.refresh_access_token(
        "r", post=lambda *a, **k: {"data": {"access_token": "N", "expires_in": 100}}
    )
    assert got["access_token"] == "N", got
    assert got["expires_at"] > time.time() + 50, got

    # 只给 access_token：过期时间从 JWT 的 exp 里解
    got = bridge_worker.refresh_access_token("r", post=lambda *a, **k: {"access_token": _jwt(4102444800)})
    assert abs(got["expires_at"] - 4102444800) < 2, got
    # 没换 refresh_token 就沿用旧的
    assert got["refresh_token"] == "r"

    # 服务端拒绝 → RuntimeError，消息里要带原因（界面直接显示它）
    try:
        bridge_worker.refresh_access_token(
            "r", post=lambda *a, **k: {"error": "invalid_grant", "error_description": "refresh token 已失效"}
        )
    except RuntimeError as e:
        assert "refresh token 已失效" in str(e), str(e)
    else:
        raise AssertionError("应该抛错")

    # 迅雷真实的 invalid_grant 文案 → 要能翻成"只能重新扫码"
    for raw in (
        "invalid_grant",
        "invalidate refresh token illegal base64 data at input byte 28",
        "invalidate refresh token bad uuid",
    ):
        try:
            bridge_worker.refresh_access_token(
                "r", post=lambda *a, _d=raw, **k: {"error": "invalid_grant", "error_description": _d}
            )
        except RuntimeError as e:
            assert "重新扫码" in str(e), f"{raw} → {e}"
        else:
            raise AssertionError(f"{raw}：应该抛错")

    # 端点不存在（迅雷改接口）也要说清楚，别露出一句英文 404
    try:
        bridge_worker.refresh_access_token(
            "r", post=lambda *a, **k: (_ for _ in ()).throw(RuntimeError("Not Found"))
        )
    except RuntimeError as e:
        assert "端点不存在" in str(e), str(e)
    else:
        raise AssertionError("应该抛错")

    # 没有 refresh_token：根本不发请求
    called = {"n": 0}

    def post_never(*a, **k):
        called["n"] += 1
        return {}

    try:
        bridge_worker.refresh_access_token("", post=post_never)
    except RuntimeError as e:
        assert "refresh_token" in str(e)
    else:
        raise AssertionError("应该抛错")
    assert called["n"] == 0, "没有 refresh_token 时不该发请求"


def refresh_flow() -> None:
    """maybe_refresh 的四种结局：还有效 / 续成功 / 没 refresh_token / 续失败"""
    with tempfile.TemporaryDirectory() as tmp:
        marker = Path(tmp) / "xunlei_login.json"
        marker.write_text(json.dumps({"user_id": "42"}), "utf-8")

        # 1) 还有效 → 不续、不写页面
        w = FakeWindow({"access_token": "a", "refresh_token": "r",
                        "expires_at": time.time() + 3600, "device_id": "d"})
        info = bridge_worker.maybe_refresh(w)
        assert info["refreshed"] is False and "有效" in info["reason"], info
        assert w.last_write is None

        # 2) 快过期 → 续 + 写回页面（保留 user_id）
        w = FakeWindow({"access_token": "a", "refresh_token": "r0",
                        "expires_at": time.time() + 30, "device_id": "d"})
        seen: dict = {}

        def fake_refresh(token, device="", **kw):
            seen["token"] = token
            seen["device"] = device
            return {"access_token": "NEW", "refresh_token": "R2", "expires_at": time.time() + 7200}

        original = bridge_worker.refresh_access_token
        bridge_worker.refresh_access_token = fake_refresh
        try:
            info = bridge_worker.maybe_refresh(w, marker=marker)
        finally:
            bridge_worker.refresh_access_token = original
        assert info["refreshed"] is True, info
        assert seen == {"token": "r0", "device": "d"}, seen
        assert w.last_write and '"NEW"' in w.last_write and '"R2"' in w.last_write, "新 token 必须写回页面"
        saved = json.loads(marker.read_text("utf-8"))
        assert saved["user_id"] == "42", "续期不能把 user_id 冲掉"
        assert saved["expires_at"] > time.time() + 3000

        # 3) 没有 refresh_token（比如 token 格式变了）→ 说明只能重扫
        w = FakeWindow({"access_token": "a", "refresh_token": "",
                        "expires_at": time.time() + 10})
        info = bridge_worker.maybe_refresh(w)
        assert info["refreshed"] is False and "refresh_token" in info["reason"], info
        assert info["logged_in"] is True, "有 access_token、只是没有 refresh_token"

        # 3b) 页面里压根没登录态 → 说"没有登录态"，而不是"续期失败"
        w = FakeWindow({"access_token": "", "refresh_token": "", "expires_at": 0})
        info = bridge_worker.maybe_refresh(w, force=True)
        assert info["logged_in"] is False and "没有登录态" in info["reason"], info

        # 5) 续期"成功"但返回的东西认不出（不是 JWT、也没有过期时间）→ 不写回
        w = FakeWindow({"access_token": "a", "refresh_token": "r0",
                        "expires_at": time.time() + 10})
        bridge_worker.refresh_access_token = lambda *a, **k: {
            "access_token": "opaque-garbage", "refresh_token": "R2", "expires_at": 0
        }
        try:
            info = bridge_worker.maybe_refresh(w)
        finally:
            bridge_worker.refresh_access_token = original
        assert info["refreshed"] is False, info
        assert "格式不认识" in info["reason"], info
        assert w.last_write is None, "认不出的 token 绝不能覆盖页面里还能用的那份"

        # 6) JWT 形态的新 token → 正常写回
        w = FakeWindow({"access_token": "a", "refresh_token": "r0",
                        "expires_at": time.time() + 10})
        bridge_worker.refresh_access_token = lambda *a, **k: {
            "access_token": _jwt(int(time.time()) + 7200), "refresh_token": "R2", "expires_at": 0
        }
        try:
            info = bridge_worker.maybe_refresh(w)
        finally:
            bridge_worker.refresh_access_token = original
        assert info["refreshed"] is True, info
        assert w.last_write and "eyJhbGciOiJIUzI1NiJ9" in w.last_write


def adapter_refresh_hook() -> None:
    """适配器要能把「续一次」和「自动续期过」这两件事透出来"""
    bridge = FakeBridge()
    ad = make_adapter(bridge)
    info = ad.ensure_fresh()
    assert bridge.calls[-1][0] == "refresh", bridge.calls[-1]
    assert info["refreshed"] is True

    # 转存时 worker 自动续过 → 界面要能显示这句
    bridge = FakeBridge(restore={
        "state": "done",
        "results": [{"source_id": "f2", "restored_id": "n2",
                     "link": "https://vod3379-aliyun04-vip-lixian.xunlei.com/x?sign=2"}],
        "refresh": "登录态快过期，已自动续期",
    })
    ad = make_adapter(bridge)
    ctx, _entries, _ = ad.parse(SHARE_URL, "")
    ad.prefetch(ctx, [ad.list_dir(ctx, "d1")[0]])
    assert ctx.get("refresh_note") == "登录态快过期，已自动续期", ctx.get("refresh_note")


def expiry_formats() -> None:
    """过期时间的三种写法都要认：数字 / 数字字符串 / ISO 8601

    真机故障（2026-10-31，下载 `Olib_3.2.1_x64-setup.exe`）：迅雷网页版把
    `expires_at` 存成 `2026-10-31T19:15:39.367Z`，代码里统一 `float()` 直接抛
        ValueError: could not convert string to float: '2026-10-31T19:15:39.367Z'
    它发生在"转存前先判断要不要续期"，于是整单转存失败，
    界面报的却是"部分文件没能开始下载" —— 看起来跟时间毫无关系。
    """
    iso = "2026-10-31T19:15:39.367Z"
    want = datetime(2026, 10, 31, 19, 15, 39, 367000, tzinfo=timezone.utc).timestamp()

    assert abs(bridge_worker.to_epoch(iso) - want) < 0.001, bridge_worker.to_epoch(iso)
    # 两份实现（worker 子进程不能 import 同包的 core）必须给出相同结果
    assert abs(epoch_seconds(iso) - want) < 0.001, epoch_seconds(iso)

    # 认不出来的都返回 0（= 不知道什么时候过期，等真 401 再续），绝不能抛
    for bad in (None, "", "   ", "什么时候过期我不知道", True, False, [], {}):
        assert bridge_worker.to_epoch(bad) == 0, bad
    assert epoch_seconds("不是时间") == 0

    # 数字 / 数字字符串 / 毫秒 / 带偏移量 / 不带时区（按 UTC）
    assert bridge_worker.to_epoch(1700000000) == 1700000000
    assert bridge_worker.to_epoch("1700000000") == 1700000000
    assert abs(bridge_worker.to_epoch(1700000000123) - 1700000000.123) < 0.001
    assert abs(bridge_worker.to_epoch("2026-11-01T03:15:39+08:00") - want) < 1
    assert abs(bridge_worker.to_epoch("2026-10-31T19:15:39") - want) < 1

    # 写回页面时按页面原来的样式（ISO 进、ISO 出）
    assert bridge_worker._iso_text(want) == iso, bridge_worker._iso_text(want)


def refresh_with_iso_expiry() -> None:
    """页面里 expires_at 是 ISO 字符串时，续期判断、写回都要正常（真机回归）"""
    now = time.time()

    # 1) 还有效 → 不续期，但必须把 ISO 解析成 epoch 再判断
    w = FakeWindow({"access_token": "a", "refresh_token": "r", "expires_at": _iso(now + 3600)})
    info = bridge_worker.maybe_refresh(w)
    assert info["refreshed"] is False, info
    assert "有效" in info["reason"], info
    assert abs(info["expires_at"] - (now + 3600)) < 3, info
    assert w.last_write is None

    # 2) 已经过期 → 续期，并且写回时保持 ISO 形态（别把字符串写成数字）
    w = FakeWindow({"access_token": "a", "refresh_token": "r0", "expires_at": _iso(now - 60)})
    original = bridge_worker.refresh_access_token
    bridge_worker.refresh_access_token = lambda *a, **k: {
        "access_token": "NEW",
        "refresh_token": "R2",
        "expires_at": now + 7200,
    }
    try:
        info = bridge_worker.maybe_refresh(w)
    finally:
        bridge_worker.refresh_access_token = original
    assert info["refreshed"] is True, info
    assert w.last_write and '"NEW"' in w.last_write, w.last_write
    assert "T" in w.last_write and "Z" in w.last_write, f"写回应保持 ISO：{w.last_write[-200:]}"

    # 3) 认不出来的过期时间 → 当"不知道"，不续期也不崩
    w = FakeWindow({"access_token": "a", "refresh_token": "r", "expires_at": "someday"})
    info = bridge_worker.maybe_refresh(w)
    assert info["state"] == "done", info
    assert info["logged_in"] is True and info["refreshed"] is False, info


CASES = [
    ("链接解析与域名识别", url_parsing),
    ("完整链路 parse→list_dir→resolve", full_chain),
    ("大文件批量转存取链（cleanup 透传）", restore_chain),
    ("转存拿不到链接 → 人话提示", restore_failure),
    ("未登录时只下小文件", restore_needs_login),
    ("直链过期丢弃缓存", invalidate_drops_stale_link),
    ("镜像只换域名不动签名", mirror_swap),
    ("JS 模板占位符全部替换", js_templates_compile),
    ("登录态提取（扫完自动关窗）", login_extract),
    ("过期登录标记会被清掉", stale_marker_is_cleared),
    ("旧版登录态迁移（profile + 标记）", legacy_migration),
    ("登录标记跟着检查结果走", marker_sync),
    ("接口错误翻成人话", error_translation),
    ("批量转存失败后快速失败 + 可重试", batch_failure_fails_fast),
    ("该续期时才续期（决策）", refresh_decision),
    ("过期时间三种写法都认（ISO 不再炸）", expiry_formats),
    ("页面存 ISO 过期时间也能正常续期", refresh_with_iso_expiry),
    ("续期接口返回形态", refresh_http_parsing),
    ("续期四种结局", refresh_flow),
    ("适配器透出续期结果", adapter_refresh_hook),
]


def main() -> int:
    safe_stdout()
    failures = 0
    for i, (name, fn) in enumerate(CASES, 1):
        try:
            fn()
        except Exception as e:  # noqa: BLE001
            failures += 1
            print(f"[{i}] {name} → FAIL：{type(e).__name__}: {e}")
        else:
            print(f"[{i}] {name} → OK")
    print("\n全部通过" if failures == 0 else f"\n{failures} 项失败")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
