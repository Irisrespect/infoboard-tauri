"""模板程序：一个最小的 tkinter 窗口。

要点（照抄就行）：

1. 程序放在插件包的 `app/` 下，**整个目录**一起打包（见 README 的打包命令）；
2. 宿主用 `pythonw app/main.py` 拉起它，工作目录就是 `app/`，所以相对路径随便用；
3. `VERSION` 文件是唯一版本事实源，必须与 manifest 的 `companion.version` 一致；
4. `--version` 让宿主/脚本能问一句（宿主平时直接读 VERSION，不启动 Python）。
"""

from __future__ import annotations

import sys
import tkinter as tk
from pathlib import Path

VERSION_FILE = Path(__file__).resolve().parent / "VERSION"


def app_version() -> str:
    try:
        return VERSION_FILE.read_text("utf-8").strip() or "0.0.0"
    except OSError:
        return "0.0.0"


def main() -> int:
    if "--version" in sys.argv[1:]:
        print(f"my-tool {app_version()}")
        return 0

    root = tk.Tk()
    root.title(f"我的工具 {app_version()}")
    root.geometry("420x220")
    tk.Label(
        root,
        text="这是一个插件自带的独立程序。\n\n"
        "它能做的：联网、写文件、常驻运行 ——\n"
        "插件(WebView)里做不到的事都可以在这里做。",
        justify="left",
        padx=18,
        pady=18,
    ).pack(anchor="w")
    tk.Button(root, text="关闭", command=root.destroy).pack(pady=8)
    root.mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
