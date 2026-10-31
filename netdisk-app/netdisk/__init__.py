"""网盘下载器 —— 核心包

一通到底只用一个下载引擎，前面挂"网盘协议适配器"：

    core.py          HTTP 客户端（cookie jar / 解压 / 流式读）、数据模型、通用格式化
    config.py        配置与登录态落盘（GUI 与 CLI 共用同一份 config.json）
    adapters.py      夸克网盘：解析分享 → 列目录 → 免转存取直链
    xunlei.py        迅雷云盘：解析分享 → 列目录（缓存）→ 免登录 / 转存取直链
    bridge_worker.py 迅雷专用的 WebView 子进程（captcha 签名只能靠网页自己算）
    services.py      链接 → 适配器 的注册表（认得出夸克和迅雷）
    tree.py          勾选的目录 → 文件清单（显式栈展开：深度可配、失败不连坐）
    downloader.py    多连接分片引擎（动态队列、直链自愈、限流退避、慢分片抢占）

两个适配器对外是同一套接口：`parse()` / `list_dir()` / `resolve()`，
所以界面（`main.py`）和命令行（`netdisk_cli.py`）都不需要知道链接是哪家的。
"""

__all__ = [
    "core",
    "config",
    "adapters",
    "xunlei",
    "services",
    "tree",
    "downloader",
    "bridge_worker",
]
