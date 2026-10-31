"""服务注册表：一条链接 → 一个网盘适配器

合并成「网盘下载」之前，两个下载器各自只有一家网盘；现在一个输入框要认两家，
所以把"认链接"这件事单独收在一处：

    ADAPTERS = (QuarkAdapter, XunleiAdapter)   ← 加一家网盘只改这一行

界面那边只跟这个模块打交道（`detect()` / `by_session()`），不认识具体类。
`by_session()` 是按网盘的持久化键（`quark` / `xunlei`）查类，用于把上次保存的
Cookie 之类装回去 —— 这两处的键必须一致，写错了就变成"登录了还是匿名档"。
"""

from __future__ import annotations

from .adapters import QuarkAdapter
from .xunlei import XunleiAdapter

# 顺序有意义：`detect()` 返回第一个命中的。两家的域名不重叠，所以顺序只影响可读性
ADAPTERS = (QuarkAdapter, XunleiAdapter)

PLACEHOLDER = "粘贴夸克 / 迅雷分享链接，如 https://pan.quark.cn/s/xxxx 或 https://pan.xunlei.com/s/xxxx?pwd=abcd"


def detect(text: str) -> type | None:
    """认出链接属于哪家网盘；认不出返回 None（界面据此给出提示）。"""
    for cls in ADAPTERS:
        try:
            if cls.match(text):
                return cls
        except Exception:
            continue
    return None


def by_session(session: str) -> type | None:
    for cls in ADAPTERS:
        if cls.session == session:
            return cls
    return None


def service_names() -> list[str]:
    return [cls.name for cls in ADAPTERS]


def host_lines() -> list[str]:
    """["夸克网盘（pan.quark.cn）", "迅雷云盘（pan.xunlei.com）"] —— 提示文案用。

    从注册表生成而不是写死：之后加第三家网盘时，所有"支持哪些网盘"的提示会自动跟上。
    """
    return [f"{cls.name}（{cls.example_host}）" for cls in ADAPTERS]
