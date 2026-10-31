# 网盘下载器（独立软件）

一个窗口认两家网盘：粘 **夸克** / **迅雷** 的分享链接 → 解析目录 → **多连接高速下载**。
独立窗口、独立进程，跑起来就不受 InfoBoard 面板开关影响。

```
netdisk-app/
├── main.py                    入口：Tkinter 界面（一个输入框，自动识别是哪家）
├── netdisk_cli.py             入口：命令行版（ls / tree / get / login / config）
├── netdisk.cmd                CLI 的 Windows 启动器（进了 PATH 就能敲 netdisk）
├── netdisk/
│   ├── core.py                HTTP 客户端（cookie jar / 自动解压 / 流式读）、数据模型
│   ├── config.py              配置与登录态落盘（GUI 与 CLI 共用同一份 config.json）
│   ├── adapters.py            ★ 夸克：解析分享 → 列目录 → 免转存取直链
│   ├── xunlei.py              ★ 迅雷：解析分享 → 列目录（缓存）→ 免登录 / 转存取直链
│   ├── bridge_worker.py       ★ 迅雷专用：WebView 子进程（captcha 只能靠网页自己算）
│   ├── services.py            链接 → 适配器 的注册表
│   ├── tree.py                勾选的目录 → 文件清单（显式栈展开：深度可配、失败不连坐）
│   └── downloader.py          多连接分片引擎（动态队列 / 直链自愈 / 限流退避 / 慢分片抢占）
└── tools/
    ├── smoke_download.py      引擎冒烟（起本地 HTTP 服务真跑，不需要账号）
    ├── smoke_adapter.py       夸克适配器冒烟（离线，喂真实形状的假响应）
    ├── smoke_xunlei.py        迅雷适配器冒烟（离线，假 runner，不开 WebView）
    ├── smoke_cli.py           CLI 冒烟（选择 / 过滤 / 进度板 / 下载链路，离线）
    └── probe_quark.py         协议探测（打真实接口，验证路径/请求体/错误码层次）
```

## 为什么做成独立软件

InfoBoard 里的插件跑在 WebView 中，**只在面板打开时运行**。网盘直链只有 5~10 分钟
有效期，大文件必然中途过期 —— 面板一关，就没人来换链，任务只能失败。
独立进程自己就能一直下、自己换链；而且不受应用 CSP 限制（插件既不能直接发请求，
也不能写文件，那两条路都得由宿主 Rust 代劳）。

## 依赖

| 网盘 | 依赖                                                                                     |
| ---- | ---------------------------------------------------------------------------------------- |
| 夸克 | **只用标准库**（tkinter + urllib），不需要 pip 任何东西                                  |
| 迅雷 | 多一个 `pywebview`（`python -m pip install pywebview`，复用系统 WebView2，不下载浏览器） |

没装 pywebview 也能用：夸克照常，点迅雷链接会明确告诉你装哪一条命令。

## 运行

```bash
# 需要 Python 3.10+（自带 tkinter，Windows 官方安装包默认带）
python main.py

# 不想看到控制台窗口的话：
pythonw main.py

# 只看版本（宿主/脚本用；宿主平时直接读 VERSION 文件，不启动 Python）
python main.py --version
# → netdisk-app 2.1.0
```

InfoBoard 里点 **☁️ 网盘下载** 也能启动它。

### 版本号（`VERSION`）

`netdisk-app/VERSION` 是**唯一事实源**（纯文本一行，如 `2.1.0`）。两处消费它：

1. `plugins/netdisk/manifest.json` 的 `companion.version` 必须与它一致 ——
   打包脚本（`scripts/pack-plugin.mjs --companion`）不等就拒绝出包；
2. 宿主启动前会读实际入口旁边的 `VERSION`，与插件声明比对，不一致弹提示（不静默跑旧代码）。

发版时改这一行 + 插件 manifest + `index.tsx` 里的 `version` 三处（有测试盯着，漏一个就红）。

## 用法

1. 粘贴分享链接（`https://pan.quark.cn/s/xxxx` 或 `https://pan.xunlei.com/s/xxxx?pwd=abcd`）
   - 输入框下方会实时显示「识别为：夸克网盘 / 迅雷云盘」
   - **提取码写在链接里就行**；也可以填进「提取码」框（会覆盖链接里的）
2. 列表里选中文件或文件夹（双击文件夹进入，← 返回上一级）→ **下载选中**
   - 选文件夹会**递归**展开，并按原目录结构落盘
   - 目录**层级不限**：默认最多展开 32 层（设置里可改），到顶的子树跳过并提示，
     同级的其它文件照下
3. 下方队列看进度/速度/状态；可以取消、双击打开所在文件夹
4. **设置** 里改保存目录、并发连接数、最多展开层数、两家的登录态

## 命令行版（CLI）

不想开界面、要写脚本或定时任务时用 `netdisk_cli.py`。它和 GUI **共用同一份配置与
登录态**（`%APPDATA%\netdisk-downloader\config.json`），所以在哪边登录都算数：

```bash
python netdisk_cli.py ls   "https://pan.quark.cn/s/xxxx"              # 列目录（序号就是 --index）
python netdisk_cli.py tree "https://pan.xunlei.com/s/xxxx?pwd=abcd" --depth 2
python netdisk_cli.py get  "https://pan.quark.cn/s/xxxx"              # 整份分享
python netdisk_cli.py get  "https://pan.quark.cn/s/xxxx" --index 1,3-5
python netdisk_cli.py get  "https://pan.quark.cn/s/xxxx" --only "*.mp4" -o D:\片 -c 32
python netdisk_cli.py get  "https://pan.quark.cn/s/xxxx" --path "课程/第1章" -j 2
python netdisk_cli.py get  "https://pan.quark.cn/s/xxxx" --dry-run    # 只列清单，不下
```

把 `netdisk-app\` 加进 PATH 之后，`netdisk.cmd` 让命令更短：`netdisk get "..."`。

| 参数                   | 作用                                                        |
| ---------------------- | ----------------------------------------------------------- |
| `--path a/b`           | 只处理分享里的子目录（`tree` 看得出层级）                   |
| `--index 1,3-5`        | 只下这一层的第几项（序号来自 `ls`）                         |
| `--only` / `--exclude` | 按 glob 挑文件，可重复或逗号分隔；带 `/` 的模式匹配相对路径 |
| `-o` / `-c` / `-j`     | 保存目录 / 每个文件的连接数 / 同时下几个文件                |
| `--dry-run`            | 只打印将要下的清单                                          |
| `--json`               | 结构化输出（`ls` / `tree` / `get` 都支持，写脚本用）        |
| `-q`                   | 只留结果行                                                  |

登录（与 GUI 互通）：

```bash
Get-Clipboard | python netdisk_cli.py login quark     # 浏览器复制的 Cookie 直接管道进来
python netdisk_cli.py login xunlei                    # 扫码（要 pywebview，会弹窗口）
python netdisk_cli.py login xunlei --status           # 只检查登录态（约 5~10 秒）
python netdisk_cli.py login status                    # 两家状态 + 配置文件路径
python netdisk_cli.py config --dest "D:\下载" --connections 32
```

- 退出码：`0` 全部成功 / `1` 有文件失败 / `2` 用法或解析错误 / `130` Ctrl+C 中断。
- 进度条只在**终端**（tty）里原地重绘（多文件并行时一行一个）；重定向到文件时
  只留"开始 / 完成"行，日志干净。
- `--json` 与管道输出统一是 UTF-8；控制台上的中文仍按系统编码（GBK）显示。
- 单个文件失败不会带走整批：其它文件继续，最后汇总失败原因并按退出码 1 返回。

**完整手册**（每个参数、`--only` 的匹配规则、JSON 结构、常见脚本、排错表）：
[docs/NETDISK_CLI.md](../docs/NETDISK_CLI.md)。

## 深层目录与长路径

分享里的结构（`课程/第 1 章/第 1 节/素材/配图/原图/xxx.png`）随手就 7~10 层，
所以这一块踩过三个坑，现在都不再限制用户：

| 坑                | 以前的表现                                                                       | 现在                                                                 |
| ----------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 展开有硬上限      | 代码里写死 `depth >= 6` 就 `raise`，**整个下载在展开阶段失败，一个文件都下不到** | 显式栈展开，上限可配（默认 32），到顶只跳过那棵子树并提示            |
| 单层超过 200 项   | 只取第 1 页，**静默少下文件**（用户以为下完了）                                  | 按 `_page` 翻页取全，直到 `metadata._total` 对上                     |
| 路径超过 260 字符 | `mkdir`/`open` 报 WinError 206/3，看起来像"下载失败"                             | 自动加 `\\?\` 长路径前缀（不改注册表、不用设置），单个名字过长会截断 |

一个目录列不出来（被删、风控）也只记一条提示，不会连坐同级的其它目录。

## 展开并发（文件多的时候）

夸克是**一层目录一次请求**：一个 500 个目录的分享串行展开要好几分钟（每次 200~600ms），
期间界面只能干等。现在展开是**按层并发**的 —— 同一层的目录一起列（默认 6 路），
结果按接口顺序拼回去，所以**顺序完全稳定**，耗时大致除以并发数：

| 展开并发  | 25 个目录（每次 50ms 模拟） |
| --------- | --------------------------- |
| 1（串行） | 1260 ms                     |
| 4         | 354 ms                      |
| 6（默认） | 253 ms                      |
| 12        | 153 ms                      |

- 设置 → 通用 → **展开并发**（1~16）。默认 6 是"够快但不容易被风控"的折中：
  这是**别人的分享接口**，同一瞬间几十个请求容易被临时限流，表现是整层失败并留提示。
- 迅雷不需要这个：解析那一步已经把整棵树抓回本地，`list_dir()` 只是查字典
  （`XunleiAdapter.parallel_expand = False`）。
- 并发只作用于**列目录**，跟下载用的「并发连接」是两套东西，别互相套用：
  下载是拉字节（越多越快），展开是问接口（太猛会被掐）。

## 两家网盘的差别（重要）

|            | 夸克网盘                               | 迅雷云盘                                                   |
| ---------- | -------------------------------------- | ---------------------------------------------------------- |
| 解析方式   | 纯 HTTP，秒级                          | 要开**隐藏 WebView**，10~20 秒（captcha 签名只能靠网页算） |
| 未登录能下 | 单文件 **≤ 约 50MB**（超了报 `23018`） | 小文件可以；大文件要**转存**到自己云盘                     |
| 登录方式   | 从浏览器复制 Cookie（至少含 `__puus`） | **扫码**（官方登录页，token 留在本机 WebView 里）          |
| 加速手段   | 多连接（按连接限速，能叠加）           | 多连接 + 可选换镜像节点（`vip=FREE` 系数由服务端定）       |
| 大文件     | 登录后直接取链                         | 转存 → 取链 → **默认立刻删掉云端副本**                     |

两家的实测数字与协议坑见 [docs/NETDISK.md](../docs/NETDISK.md)（夸克第 3 节、迅雷第 9 节）。

> 这些数字来自本机可复现实测，不是推测。速度随时段和账号波动很大，
> 遇到"整体塌陷时段"是正常的。

## 登录

### 夸克

1. 浏览器打开 `pan.quark.cn` 并登录
2. `F12` → **Application** → **Cookies** → `https://pan.quark.cn`
3. **只复制 quark.cn 域下的那些项**（至少要有 `__puus`），粘到「设置 → 夸克」
4. 点「检查」：会说"关键项齐全 ✓"或者点名缺哪个

⚠️ **不要把浏览器全部 Cookie 都粘进来**：实测整份（约 7.2KB，含大量无关域）
会被服务端直接掐断连接。只要该网盘域下的那一份（通常 20~30 项）。

### 迅雷

设置 → 迅雷 → **扫码登录…** → 弹出的官方登录页里扫码 → 窗口自动关闭。
token 只留在 `%LOCALAPPDATA%\netdisk-downloader\webview` 这个 WebView profile 里，
配置文件里只有 `user_id` 标记。

**登录态会自动续期**：access_token 快到点（10 分钟内）或转存撞上 401 时，用
refresh_token 静默换一套新的、写回本机，然后继续干活 —— 不用再扫一次码。
设置里还有个「刷新登录态」按钮，想立刻续一次可以点它（详情见 `docs/NETDISK.md` 第 9 节）。

> 从旧版「迅雷下载器」升级过来的人不用重扫：首次启动会把
> `%LOCALAPPDATA%\XunleiDL\webview` 的 profile 复制一次过来（仅当新目录为空）。

## 已知限制

- **只有夸克和迅雷**。蓝奏云/百度/阿里云盘等未接入（原因见 `docs/NETDISK.md` 第 3 节末表）。
- 勾选文件夹时是**递归展开**下载，不做"打包成一个 zip"。
- 断点续传只在**同一次运行内**有效：关掉软件再打开，已完成的分片不会复用，
  会重新下（要支持跨次续传得额外落一份分片完成表）。
- 夸克 Cookie 明文存在 `%APPDATA%\netdisk-downloader\config.json`，
  别把这个文件拷给别人。
- 直链过期会自动换链（最多 5 次）；换链要重新解析，夸克 1~2 秒、迅雷要再开一次浏览器（10 秒级）。
- 夸克是**逐层请求**（设置里默认 32 层够用）；迅雷的整棵树在解析时一次抓完，
  最多 24 层，更深的分支不会进树里 —— 那种分享建议把子目录的分享链接单独发出来。

## 自测

```bash
# 引擎：多连接拼装是否逐字节正确 / 过期换链续传 / 不支持 Range 时退回单连接
python tools/smoke_download.py

# 夸克：parse → 列目录 → 取链整条链（离线，用假响应，不碰真实网络）
python tools/smoke_adapter.py

# 迅雷：整棵树摊平 / 翻目录不开浏览器 / 批量转存 / JS 模板占位符 / 登录态提取（离线）
python tools/smoke_xunlei.py

# CLI：选择/过滤、进度板重绘、下载链路（本地 HTTP 真跑）、--help/退出码（离线）
python tools/smoke_cli.py

# 协议：打真实接口验证路径与错误码层次（用无效 ID，不需要账号）
python tools/probe_quark.py

# 想验证一个真实分享链接能不能解析（只读：不下载、不转存）
python tools/probe_quark.py "https://pan.quark.cn/s/xxxxxxxx"
```

`safe_stdout()` 不是摆设：Windows 控制台默认 GBK，一个 emoji 就能让 `print` 抛错、
把**跑完的测试结果**毁成退出码 1（看起来像测试失败）。

> 这几个脚本分工不同，缺一不可：`smoke_download.py` 只测**下载引擎**，它一个协议函数
> 都不经过 —— 所以"适配器代码根本跑不起来"的错只有后两个能抓到
> （`'ShareCtx' object is not subscriptable` 就是这么漏出去的）。
> `smoke_cli.py` 补的是另一层：参数怎么落到条目上（`--index`/`--only`）、
> 进度板会不会在管道里吐 ANSI、单文件失败会不会带走整批 —— 这些都在 CLI 里，
> 三个旧脚本一行都覆盖不到。
