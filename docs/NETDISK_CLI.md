# 网盘下载器 · 命令行版（netdisk_cli.py）

给「网盘下载器」用的命令行入口：认夸克 / 迅雷的分享链接，列目录、挑文件、多连接下载。
界面版（`main.py`）能做的事它都能做，只是把"点鼠标"换成了参数，方便写脚本、挂计划任务、
或者在服务器上跑。

> 协议实现、目录展开、分片引擎一份都不重写 —— 全部和对面的 GUI 共用 `netdisk-app/netdisk/`。
> 这份文档讲的是**怎么用**；协议细节（接口序列、错误码、实测数字）见
> [NETDISK.md](NETDISK.md)。

---

## 1. 环境

| 项     | 要求                                                                                          |
| ------ | --------------------------------------------------------------------------------------------- |
| Python | **3.10+**（Windows 官方安装包自带 tkinter，CLI 本身不需要它）                                 |
| 夸克   | 只用标准库，零依赖                                                                            |
| 迅雷   | 解析/转存要 `pywebview`：`python -m pip install pywebview`（复用系统 WebView2，不下载浏览器） |
| 系统   | Windows（长路径、WebView2 这些都按 Windows 写）；Linux/macOS 未验证                           |

```bash
cd netdisk-app
python netdisk_cli.py --help
```

把 `netdisk-app\` 加进 `PATH` 之后可以用自带的启动器，命令更短：

```bat
netdisk ls  "https://pan.quark.cn/s/xxxx"
netdisk get "https://pan.quark.cn/s/xxxx" -o D:\片 -c 32
```

`netdisk.cmd` 只做两件事：找 `python`（找不到退回 `py -3`），把参数原样转给
`netdisk_cli.py`，并透传退出码。

---

## 2. 60 秒上手

```bash
# 1) 先看有什么（序号就是后面 --index 用的）
python netdisk_cli.py ls "https://pan.quark.cn/s/xxxx"

# 2) 整份分享下到默认目录
python netdisk_cli.py get "https://pan.quark.cn/s/xxxx"

# 3) 只挑一部分
python netdisk_cli.py get "https://pan.quark.cn/s/xxxx" --index 1,3-5
python netdisk_cli.py get "https://pan.quark.cn/s/xxxx" --only "*.mp4"

# 4) 进子目录、整目录递归、32 连接、存到 D:\片
python netdisk_cli.py get "https://pan.quark.cn/s/xxxx" --path "课程/第1章" -o D:\片 -c 32
```

默认保存目录是 `%USERPROFILE%\Downloads\网盘下载`（可在 `config` 里改，和 GUI 同一个值）。

---

## 3. 命令速查

| 命令           | 作用                                          | 会不会写盘         |
| -------------- | --------------------------------------------- | ------------------ |
| `ls <链接>`    | 列当前层（分享根目录或 `--path` 指的目录）    | 不写               |
| `tree <链接>`  | 打目录树，用来找 `--path`                     | 不写               |
| `get <链接>`   | 下载（默认整层，可 `--index` / `--only` 挑）  | 写                 |
| `login quark`  | 存夸克 Cookie                                 | 写配置             |
| `login xunlei` | 扫码登录 / `--status` 检查 / `--refresh` 续期 | 写 WebView profile |
| `login status` | 打印两家登录态 + 配置文件路径                 | 不写               |
| `config`       | 看/改保存目录、并发、展开参数                 | 改配置             |

`ls` / `tree` / `get` 共用的三个参数：

| 参数                 | 说明                                                                |
| -------------------- | ------------------------------------------------------------------- |
| `-p, --pwd <提取码>` | 链接里带 `?pwd=abcd` 就不用给；给了会覆盖链接里的                   |
| `--path a/b/c`       | 进分享内的子目录（`tree` 看得出层级），逐层匹配，先精确后忽略大小写 |
| `--json`             | 输出 JSON，给脚本吃（此时 stdout 只有 JSON，见第 9 节）             |

---

## 4. `ls`：列目录

```bash
python netdisk_cli.py ls "https://pan.quark.cn/s/xxxx"
python netdisk_cli.py ls "https://pan.quark.cn/s/xxxx" --path "课程/第1章"
```

输出示例：

```text
夸克网盘 · 课程 · 已登录
1  目录       —  第1章/
2  文件   1.2 GB  第1集.mp4
3  文件  86.3 MB  讲义.pdf
```

- **序号从 1 开始，只对"这一层"有效** —— 它就是 `get --index` 认的那个号。
- 头部第一行显示：网盘 / 当前目录（没进子目录时显示分享标题）/ 登录状态。
- `--json` 结构：

```json
{
  "service": "夸克网盘",
  "title": "课程",
  "path": ["课程", "第1章"],
  "entries": [
    {
      "index": 1,
      "name": "第1集.mp4",
      "type": "file",
      "size": 1288490188,
      "size_text": "1.2 GB",
      "id": "..."
    }
  ]
}
```

---

## 5. `tree`：看层级

```bash
python netdisk_cli.py tree "https://pan.quark.cn/s/xxxx"
python netdisk_cli.py tree "https://pan.quark.cn/s/xxxx" --depth 5
```

```text
夸克网盘 · 分享根目录（最多展开 3 层）
课程/
  第1章/
    第1集.mp4  1.2 GB
    讲义.pdf  86.3 MB
  封面.jpg  1.1 MB
```

- `--depth` 默认 3，上限 1024（再深也没有意义，路径先炸）。到顶的目录标
  `…（到达 --depth 上限，未展开）`。
- 单个目录列不出来只在该节点标 `! 原因`，不影响兄弟目录。
- 夸克是**一层目录一次请求**，`--depth` 开很大就是很多次请求，别拿它扫全站。
- 迅雷的整棵树在**解析那一步**就抓回本地了，`list_dir` 只是查字典，随便翻。

---

## 6. `get`：下载

### 6.1 选什么

按这个顺序生效：

1. **`--path`** 决定从哪一层开始（不写 = 分享根目录）。
2. **`--index`** 在这一层里挑几项（不写 = 这一层全部，目录会被递归展开）。
3. **递归展开**：选中的目录按原结构展开成文件清单，默认最多 32 层
   （`--max-depth` 或配置里的 `max_depth` 覆盖），到顶的子树跳过并打一条提示。
4. **`--only` / `--exclude`** 在展开后按**相对路径**过滤。
5. **`--limit N`** 最后截断。

| 参数        | 写法                                   | 说明                                 |
| ----------- | -------------------------------------- | ------------------------------------ |
| `--index`   | `1`、`1,3,5`、`2-4`、`5-3`（自动反序） | 1 基；重复自动去重；越界直接报错退 2 |
| `--only`    | `*.mp4`、`*.mp4,*.mkv`、`课程/第1章/*` | 可重复给，也可逗号分隔               |
| `--exclude` | `*.nfo`、`素材/*`                      | 同上，优先级高于 `--only`            |
| `--limit`   | `100`                                  | 0 / 不写 = 不限                      |

匹配规则（`--only` / `--exclude` 一样）：

- **不带 `/`** 的模式只匹配**文件名**，且忽略大小写 —— `*.mp4` 能命中任意层级的 mp4。
- **带 `/`** 的模式匹配**落盘相对路径**（含 `--path` 前缀，从保存目录算起）——
  `第1章/*` 命中 `<目标>\第1章\...`；要连前缀一起限定就写 `课程/第1章/*`。
- 用 `[]`、`?` 这类 glob 语法也照常生效（`fnmatch` 语义）。

```bash
# 只下这一层的第 1、3、4、5 项
python netdisk_cli.py get "URL" --index 1,3-5

# 进"课程"目录，只挑 mp4，但排除预告片
python netdisk_cli.py get "URL" --path "课程" --only "*.mp4" --exclude "*预告*"

# 先确认要下什么（不写盘）
python netdisk_cli.py get "URL" --only "*.mp4" --dry-run
```

### 6.2 下到哪

- 目标目录：`-o/--dest`，没给就用配置里的 `dest_dir`。
- **保持分享里的目录结构**：`--path 课程` 下的 `第1章/第1集.mp4` 落到
  `<目标>\课程\第1章\第1集.mp4`。
- 文件名会清洗掉 Windows 非法字符（`<>:"/\|?*` 和控制字符），单个名字过长会截断。
- **重名默认另存**为 `名称 (1).ext`，不覆盖已有文件；要覆盖加 `--overwrite`。
  同一批里两个条目同名（少见）也走同一规则。
- 深层目录（十几层 + 中文名）会自动加 `\\?\` 长路径前缀，不需要改注册表，
  也不会撞 `MAX_PATH` 报 `WinError 206/3`。

### 6.3 快不快

两套参数别混：

| 参数                | 含义                                                    | 默认              |
| ------------------- | ------------------------------------------------------- | ----------------- |
| `-c, --connections` | **每个文件**开几条连接拉字节（1~128，超出会被夹到边界） | 配置值（默认 16） |
| `-j, --jobs`        | **同时下几个文件**（1~16）                              | 1                 |
| `--expand-workers`  | 展开目录时同一层并发列几个目录（1~16）                  | 配置值（默认 6）  |

引擎侧固定参数（`netdisk/downloader.py`）：片数 ≈ 连接数 × 32、单片 ≥ 256KB；
直链过期自动换链最多 5 次；限流（429/503）时全体退避，从 30 秒起翻倍、上限 5 分钟；
15 秒没数据的分片交回队列换条连接。

- 夸克**未登录**是整体限速，加 `-c` 没用；登录后才是"按连接限速、多连接叠加"。
- 分享接口会被风控：`--expand-workers` 开太大容易整层失败（有提示，不会静默少文件）。
- `-j` 再大也就那样：瓶颈通常在服务端单连接速度，`-j 2~4` 已经够。

### 6.4 进度长什么样

- **终端里**：每个在下的文件一行，原地重绘（`[2/12] 第1集.mp4 [#####-----] 46.2% 1.2 GB/2.6 GB 18.4 MB/s`）。
  行数变少时会把多余的行擦掉，不留残影。
- **重定向到文件 / 管道**：不画进度板（也不会吐 ANSI 转义），只留
  `[2/12] 开始 …` / `[2/12] 完成 … → 路径` 这种一行一条的流水。
- `-q/--quiet`：连流水也不要，只留最后的汇总。
- `--json`：**stdout 只有 JSON**（人类可读的东西全关），方便 `| jq` 或 `ConvertFrom-Json`。

结束时的汇总：

```text
完成 11/12 个 · 3.4 GB · 用时 96.3s（平均 36.1 MB/s）
  失败 第7集.mp4：HTTP 403：直链已过期……
```

单个文件失败**不会**带走整批：其它文件继续下，失败原因逐条打到 stderr，退出码 1。

### 6.5 输出 JSON

成功/失败的完整结果：

```json
{
  "service": "夸克网盘",
  "title": "课程",
  "dest": "D:\\片",
  "total": 12,
  "done": 11,
  "failed": 1,
  "cancelled": 0,
  "bytes": 3650722201,
  "seconds": 96.34,
  "files": [
    {
      "name": "第1集.mp4",
      "rel": "第1章",
      "path": "D:\\片\\第1章\\第1集.mp4",
      "size": 1288490188,
      "state": "done",
      "message": "",
      "seconds": 12.4
    }
  ]
}
```

`state` 取值：`done` / `failed` / `cancelled`（正常跑完不会有 `pending`/`running`）。

`--dry-run --json` 输出的是计划清单（没有 `done`/`state`，多了每个文件的绝对 `path`）：

```json
{
  "service": "夸克网盘",
  "title": "课程",
  "dest": "D:\\片",
  "total": 2,
  "bytes": 1374926280,
  "files": [
    { "name": "第1集.mp4", "rel": "第1章", "size": 1288490188, "path": "D:\\片\\第1章\\第1集.mp4" }
  ]
}
```

---

## 7. `login`：登录态

CLI 和 GUI **共用同一份配置**（`%APPDATA%\netdisk-downloader\config.json`），
在哪边登录都算数，不用重复登。

### 7.1 夸克（粘 Cookie）

```powershell
# 浏览器里登录 pan.quark.cn → F12 → Application → Cookies → pan.quark.cn
# 把那一份复制出来，直接管道进来
Get-Clipboard | python netdisk_cli.py login quark

# 或者显式给
python netdisk_cli.py login quark --cookie "__puus=...; __pus=...; ..."
python netdisk_cli.py login quark --cookie-file cookie.txt
```

要点：

- **只复制 `quark.cn` 域下的那些项**（通常 20~30 条，至少含 `__puus`）。把浏览器
  **全部** Cookie（约 7KB、含大量无关域）粘进来，服务端会直接掐断连接。
- 成功后打印 `已保存 N 项夸克 Cookie（关键项齐全）`，并写进配置文件。
- 匿名也能用：**只下 ~50MB 以内**的单个文件；超了报 `23018`。想下大文件、想靠多连接
  提速，必须登录。

### 7.2 迅雷（扫码）

```bash
python netdisk_cli.py login xunlei              # 弹官方登录页，扫码，成功后窗口自己关
python netdisk_cli.py login xunlei --status     # 只检查登录态（隐藏窗口，5~10 秒）
python netdisk_cli.py login xunlei --refresh    # 用 refresh_token 静默续期
```

- token 只留在 `%LOCALAPPDATA%\netdisk-downloader\webview`（WebView2 profile），
  配置文件里只有一个 `user_id` 标记。别删这个目录，删了等于掉登录。
- 迅雷的分享接口要求 `captcha_sign`（设备签名），**只能在网页上下文里算** ——
  所以每次"解析一个分享"都会短暂起一个无窗口浏览器（10~20 秒）。这是协议决定的，
  不是 CLI 慢。
- 大文件要先转存到自己云盘才能取直链（转存要空间，取完默认删副本）。
  转存路径会自己续期，掉到 401/403 会续一次再重试。
- 没装 pywebview：夸克照常，点迅雷链接会明确告诉你 `python -m pip install pywebview`。

### 7.3 看状态

```bash
python netdisk_cli.py login status
```

```text
夸克：已保存 21 项 Cookie，关键项 有
迅雷：未登录（小文件直接下；转存大文件要先扫码）
配置：C:\Users\你\AppData\Roaming\netdisk-downloader\config.json
```

---

## 8. `config`：配置

```bash
python netdisk_cli.py config                       # 只看（Cookie 只显示项数，不回显原文）
python netdisk_cli.py config --dest "D:\下载" --connections 32
python netdisk_cli.py config --max-depth 64 --expand-workers 8
python netdisk_cli.py config --no-xunlei-cleanup   # 转存后保留云端副本
```

| 字段             | 含义                                                 | 默认                               |
| ---------------- | ---------------------------------------------------- | ---------------------------------- |
| `dest_dir`       | 默认保存目录                                         | `%USERPROFILE%\Downloads\网盘下载` |
| `connections`    | 每个文件的并发连接数                                 | 16                                 |
| `max_depth`      | 展开目录的最大层数（1~1024，非法值回默认 32）        | 32                                 |
| `expand_workers` | 展开目录的同层并发（1~16）                           | 6                                  |
| `xunlei_cleanup` | 转存取链后删云端副本                                 | `true`                             |
| `xunlei_mirror`  | 直链换镜像节点（实验，换错会 403）                   | `false`                            |
| `cookies`        | 各家登录态（**夸克 Cookie 明文**，别把文件拷给别人） | `{}`                               |

改完立即写入，GUI 下次读到的就是新值；反向也一样。

---

## 9. 输出与退出码

| 退出码 | 含义                                                                     |
| ------ | ------------------------------------------------------------------------ |
| `0`    | 全部成功（`--dry-run` 也算成功）                                         |
| `1`    | 有文件失败（`get` 才可能）                                               |
| `2`    | 用法或解析错误：认不出链接、分享不存在、提取码错、序号越界、没选中文件…… |
| `130`  | `Ctrl+C` 中断                                                            |

编码：

- **控制台**：跟随系统代码页（中文 Windows 是 GBK），中文正常显示；内部把编码错误降级，
  不会因为一个特殊字符把跑完的结果变成异常退出。
- **管道 / 重定向 / `--json`**：统一 **UTF-8**，脚本按 UTF-8 读。

PowerShell 里想稳妥处理中文输出，可以：

```powershell
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new()
```

---

## 10. 常见脚本

**批量跑一批链接，只要 mp4，串行**（PowerShell）：

```powershell
$dest = "D:\片"
Get-Content links.txt | Where-Object { $_.Trim() } | ForEach-Object {
    python netdisk_cli.py get $_.Trim() --only "*.mp4" -o $dest -q
    "退出码 $LASTEXITCODE : $_"
}
```

**按 JSON 结果决定后续动作**：

```powershell
$r = python netdisk_cli.py get $url --json -o D:\片 | ConvertFrom-Json
if ($r.failed -gt 0) {
    $r.files | Where-Object state -ne "done" | ForEach-Object { "$($_.rel)/$($_.name)：$($_.message)" }
    exit 1
}
```

**计划任务**（每天 02:00 下一份固定分享）。`/TR` 里塞带引号的整条命令很容易翻车，
先落一个批处理再挂任务：

```bat
rem D:\scripts\netdisk-nightly.cmd
@echo off
python D:\infoboard-tauri-source\netdisk-app\netdisk_cli.py get "https://pan.quark.cn/s/xxxx" -o D:\下载 -q
```

```bat
schtasks /Create /TN "netdisk-nightly" /SC DAILY /ST 02:00 /TR "D:\scripts\netdisk-nightly.cmd"
```

**只看不下（巡检分享是否还在、有多大）**：

```bash
python netdisk_cli.py tree "URL" --depth 1 --json | jq '.nodes | length'
```

**给 GUI 用的人留一句**：CLI 和 GUI 可以同时开 —— 两边是独立进程、独立的 Cookie 会话，
配置各读各写。但**别让两边同时下同一个文件**：后启动的那个会按"重名另存"落成
`x (1).mp4`，白下一份。

---

## 11. 已知限制

- **断点续传只在同一次运行内有效**：关掉再开，已完成的分片不复用，会重下。
- **只有夸克和迅雷**，蓝奏云 / 百度 / 阿里云盘未接入（原因见 [NETDISK.md](NETDISK.md) 第 3 节末表）。
- 迅雷的整棵树是解析时一次抓完的，**最多 24 层**；更深的分支不在树里，
  那种分享建议把子目录的分享链接单独发出来。
- 夸克匿名单文件 ~50MB 上限（错误码 `23018`）。
- `--index` 是"这一层"的序号，不是全分享的全局编号；换层要重新 `ls`。
- 迅雷每次解析都要开一次 WebView（10~20 秒），**一次 `get` 传多个条目**比分多次跑高效。
- 直链 5~10 分钟就过期；大文件靠自动换链兜着（最多 5 次），夸克换链 1~2 秒、
  迅雷要再开一次浏览器。

---

## 12. 排错

| 现象                                                                | 原因                       | 怎么办                                               |
| ------------------------------------------------------------------- | -------------------------- | ---------------------------------------------------- |
| `错误：认不出这是哪家网盘的链接`                                    | 不是两家的分享域名         | 只支持 `pan.quark.cn` / `pan.xunlei.com`             |
| `夸克解析失败：提取码错误`                                          | 提取码不对 / 链接没带      | `-p abcd`，或检查链接里的 `?pwd=`                    |
| `分享不存在或已被删除`                                              | 链接失效                   | 重新找分享者要                                       |
| `未登录时只能取到约 50MB 以下文件的直链（…23018）`                  | 夸克匿名限额               | `login quark`                                        |
| `HTTP 401/403/412：直链已过期或被拒绝`                              | 直链过期或风控             | 已自动换链仍失败就重跑；或降 `-c`                    |
| `触发服务端限流，静默 N 秒后继续`                                   | 连接太多                   | 降 `-c` / 等一会儿                                   |
| `迅雷解析超时（300 秒）`                                            | 网页接口卡住               | 重试；确认能打开 `pan.xunlei.com`                    |
| `这个大文件要先进你自己的迅雷云盘才能取到直链`                      | 未登录或空间满             | `login xunlei`；清云盘空间                           |
| `Python not found: install 3.10+ and tick "Add python.exe to PATH"` | PATH 里没有 python         | 装 3.10+ 并勾上那项；或直接用 `py -3 netdisk_cli.py` |
| `ModuleNotFoundError: webview`                                      | 缺 pywebview（只影响迅雷） | `python -m pip install pywebview`                    |
| `序号超出范围`                                                      | `--index` 比这一层条目多   | 先 `ls` 看一眼                                       |
| 中文在管道里是乱码                                                  | 接收端按 GBK 解码          | 按 UTF-8 读输出（CLI 管道输出就是 UTF-8）            |
| 进度条把日志顶乱                                                    | 日志被当终端               | 加 `-q` 或 `--json`（非 tty 本来就不画板）           |

---

## 13. 源码在哪

| 文件                                                                        | 内容                                                         |
| --------------------------------------------------------------------------- | ------------------------------------------------------------ |
| [`netdisk-app/netdisk_cli.py`](../netdisk-app/netdisk_cli.py)               | 参数解析、选条目、进度板、`login` / `config` 子命令          |
| [`netdisk-app/netdisk/config.py`](../netdisk-app/netdisk/config.py)         | 配置与登录态落盘（GUI + CLI 共用）                           |
| [`netdisk-app/netdisk/services.py`](../netdisk-app/netdisk/services.py)     | 链接 → 适配器 注册表（加第三家网盘只改这里）                 |
| [`netdisk-app/netdisk/adapters.py`](../netdisk-app/netdisk/adapters.py)     | 夸克：解析 → 列目录 → 免转存取直链                           |
| [`netdisk-app/netdisk/xunlei.py`](../netdisk-app/netdisk/xunlei.py)         | 迅雷：解析（WebView）→ 缓存树 → 免登录 / 转存取直链          |
| [`netdisk-app/netdisk/tree.py`](../netdisk-app/netdisk/tree.py)             | `--index/--path` 选中的条目 → 文件清单（按层并发、深度可配） |
| [`netdisk-app/netdisk/downloader.py`](../netdisk-app/netdisk/downloader.py) | 多连接分片、直链自愈、限流退避、慢分片抢占                   |
| [`netdisk-app/tools/smoke_cli.py`](../netdisk-app/tools/smoke_cli.py)       | CLI 冒烟：29 项检查，含假适配器 + 本地 HTTP 的完整 `get`     |

自测（都不需要账号、不碰真实网盘）：

```bash
cd netdisk-app
python tools/smoke_cli.py        # CLI 这层：选择/过滤、进度板、下载链路、退出码
python tools/smoke_download.py   # 引擎：分片拼装、换链续传、无 Range 退单连接
python tools/smoke_adapter.py    # 夸克适配器（离线假响应）
python tools/smoke_xunlei.py     # 迅雷适配器（离线假 runner，不开 WebView）
```
