"""配置与登录态落盘（GUI 与 CLI 共用）

这个模块从 `main.py` 里搬出来的，原因是现在有两个入口：

    main.py          Tkinter 界面
    netdisk_cli.py   命令行

两边必须读**同一个** `%APPDATA%\\netdisk-downloader\\config.json` —— 在 GUI 里
扫过码、粘过夸克 Cookie，敲 cli 时不该再登录一次；反过来 CLI 里 `login quark`
粘的 Cookie，GUI 打开也该是登录状态。所以配置的默认值、键名、落盘位置收在这里，
任何一边都不再自带一份副本。

注意：夸克 Cookie 存在这个文件里（明文）。它等价于登录态，
所以别把这个文件拷给别人 —— README 里也写了。
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from .tree import DEFAULT_MAX_DEPTH, DEFAULT_WORKERS

# 并发连接：默认 16。两家都按「连接」限速，多连接能叠加（详见 docs/NETDISK.md）
DEFAULT_CONNECTIONS = 16
CONNECTION_CHOICES = [1, 2, 4, 8, 16, 24, 32, 48, 64]

# 配置目录：%APPDATA%\netdisk-downloader（迅雷的 WebView profile 在 LOCALAPPDATA，见 xunlei.py）
CONFIG_DIR = Path(os.environ.get("APPDATA") or Path.home()) / "netdisk-downloader"


def default_dest_dir() -> str:
    return str(Path.home() / "Downloads" / "网盘下载")


class Config:
    """配置与登录态落盘（JSON）"""

    def __init__(self) -> None:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        self.path = CONFIG_DIR / "config.json"
        self.data: dict[str, Any] = {
            "dest_dir": default_dest_dir(),
            "connections": DEFAULT_CONNECTIONS,
            "cookies": {},
            # 勾选文件夹时最多往下展开多少层。以前这里是**硬编码 6 层并且直接抛错**
            # （见 netdisk/tree.py 的说明）：夸克分享超过 6 层就整批下不了，
            # 而这个上限本来只是"别被病态分享拖死"的保险丝，不该管用户要下什么。
            "max_depth": DEFAULT_MAX_DEPTH,
            # 展开目录时同一层并发列几个目录。夸克一层一次请求，串行展开几百个目录
            # 要好几分钟；按层并发（默认 6）能把这个时间除以并发数（见 netdisk/tree.py）。
            # 别跟「并发连接」搞混：这个只列目录，不占下载带宽。
            "expand_workers": DEFAULT_WORKERS,
            # 迅雷：转存取链后立刻删掉云端副本（否则白占空间）
            "xunlei_cleanup": True,
            # 迅雷：直链换镜像节点提速（实验，默认关 —— 换错节点会 403）
            "xunlei_mirror": False,
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

    # ── 登录态 ──

    def saved_cookies(self, session: str) -> str:
        return str((self.data.get("cookies") or {}).get(session) or "")

    def set_cookies(self, session: str, raw: str) -> None:
        self.data.setdefault("cookies", {})[session] = raw
        self.save()

    def masked(self) -> dict[str, Any]:
        """给 `config` 子命令看的一份：Cookie 只留名字和项数"""
        view = dict(self.data)
        jar = view.get("cookies") or {}
        view["cookies"] = {
            key: f"（已保存 {sum(1 for p in str(raw).split(';') if '=' in p)} 项）" if raw else ""
            for key, raw in jar.items()
        }
        return view
