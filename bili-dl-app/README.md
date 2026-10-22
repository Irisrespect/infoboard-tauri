# B 站下载器（独立程序）

InfoBoard 插件 `bili-dl` 的「真·下载」部分。插件跑在 WebView 里，不能发请求、不能写文件、
不能起进程，所以下载这一步只能由独立进程做 —— 和 `netdisk-app/` 是同一个思路。

## 用法

双击 **`启动.bat`**，或命令行：

```powershell
pythonw .\bili_dl.py
```

界面里：粘链接（可多行）→ 选画质 → 开始下载。

## 依赖

| 依赖                        | 用途               | 缺失时                                                      |
| --------------------------- | ------------------ | ----------------------------------------------------------- |
| Python 3.9+（自带 tkinter） | 跑界面             | 启动.bat 会提示                                             |
| `yt-dlp`                    | 解析 + 下载        | 点界面右上角「安装 yt-dlp」，自动 `pip install -U yt-dlp`   |
| `ffmpeg`                    | 合并音视频、转 mp3 | 只有「仅音频 m4a」不需要；建议 `winget install Gyan.FFmpeg` |

## 参数说明

- **画质**：最高 / 4K / 1080P / 720P / 480P / 仅音频 m4a / 仅音频 mp3
- **编码**：H.264（兼容性最好）/ HEVC / AV1（体积最小）
- **登录态**：1080P60 / 4K / 大会员画质、以及大部分番剧都需要它。两条路：
  - **直接从浏览器读**：Vivaldi / Chrome / Edge / Firefox。Chromium 系（Vivaldi、Chrome、Edge）
    **运行时会独占 Cookies 数据库**，必须先完全退出浏览器（Vivaldi 连后台进程一起退），
    否则 yt-dlp 只会报 `Could not copy Chrome cookie database`；
  - **cookies.txt**：用浏览器扩展导出 Netscape 格式的 `cookies.txt`，
    在界面里指定一次即可，**不用关浏览器**。Chrome 127+/Edge 的 Cookie 受 ABE 加密
    （yt-dlp#10927），只能走这条路或换 Firefox。

  读不到 Cookie 时程序会自动去掉登录态重试一次，并在日志里说明原因，不会整次白跑。

- **分P**：留空 = 全部；支持 `1,3-5` 这种写法
- **保存到**：默认 `%USERPROFILE%\Downloads\Bilibili`

配置存在 `%APPDATA%\bili-dl-app\config.json`（不含任何登录凭证，Cookie 由 yt-dlp 直接读浏览器）。

## 之后要接进 InfoBoard

`netdisk` 之所以能「点图标就拉起」，是因为应用里有 `netdisk_app_launch` 这个 Rust 命令
（`src-tauri/src/plugins/netdisk/app.rs` + `core::companion`）。那套是**每个程序一组命令**、
刻意不做通用启动器，所以把这个程序接进面板需要加一对 `bili_app_status` / `bili_app_launch`
并重新编译 —— 属于改应用源码，默认不做。
