"""网盘下载器 —— 核心包（只用标准库）

模块划分：
    core.py        HTTP 客户端（cookie jar / 解压 / 流式读）、数据模型、通用格式化
    adapters.py    各家网盘的协议实现（目前只有夸克）
    downloader.py  多连接分片下载引擎（动态队列、直链自愈、限流退避、慢分片抢占）
"""

__all__ = ["core", "adapters", "downloader"]
