# 网盘下载（InfoBoard 插件）

工具区一个图标，点开独立的 **[网盘下载器](../netdisk-app/README.md)** ——
夸克和迅雷**共用一个输入框**：粘链接、解析目录、多连接高速下载。

```bash
# 程序本体一起打进包（改了 netdisk-app/ 只需要发这一个包）
node scripts/pack-plugin.mjs plugins/netdisk --companion netdisk-app
# → dist-plugins/netdisk-2.1.0.ibplugin（约 90 KB，含 app/ 下 14 个文件）
```

## 2.1.0：插件自带程序（供应商不再绑在安装包上）

**这是结构性修复。** 之前插件的"本体"（`netdisk-app/`）只能随应用安装包发，
于是改一行 Python 也得让用户重装整个 InfoBoard —— `.ibplugin` 这个热更新通道
对启动器类插件形同虚设，插件版本号只能空转（2.0.1 / 2.0.2 就是这么来的）。

现在插件包**自带程序**：

```json
"companion": { "dir": "app", "entry": "main.py", "version": "2.1.0" }
```

宿主的查找顺序变成：

```
用户手动指定
  → 插件包自带（plugins/<id>/app/main.py）   ← 装了插件就用这份
  → 随包 resources / exe 上层 / cwd（取最新）  ← 没装插件时的兜底
```

所以：

| 改动 | 要发什么 |
| --- | --- |
| 插件 UI（`index.tsx`） | `.ibplugin` |
| 程序逻辑（`netdisk-app/`） | **`.ibplugin`**（以前只能重装应用） |
| 宿主 Rust / 前端壳 | 安装版（没变） |

版本契约（C）：`netdisk-app/VERSION` 是唯一事实源，`manifest.companion.version`
必须与它一致 —— 打包脚本不等就拒绝出包；宿主启动时还会把实际入口旁的 `VERSION`
和 manifest 声明比一次，不一致会弹 toast + 写日志（不静默跑旧代码）。

> 宿主 0.9 起这条机制**对任何插件 id 都成立**（不再限于注册表里那三个）：
> 新插件只要在 manifest 里写 `companion`，`companion_launch({id:"<插件 id>"})`
> 就能跑它包里那份程序 —— 也就是"只发一个 `.ibplugin` 就能加功能"。
> 模板见 [`plugins/.launcher-template/`](../.launcher-template/README.md)。

## 2.0.2：展开并发 + 迅雷续期崩溃（配 netdisk-app 的修复）

插件还是那个启动器，版本号跟着 `netdisk-app/` 的两处修复一起走
（那时改动都在 `netdisk-app/`，**随应用资源打包**，2.1.0 之后不需要了）：

- **并发展开**：一层目录一次请求的夸克，500 个目录串行要好几分钟；现在同层并发
  （默认 6，设置里 1~16 可调），实测 25 个目录 1260ms → 253ms，**文件顺序不变**
- **迅雷转存崩溃**：`expires_at` 是 ISO 字符串（`2026-10-31T19:15:39.367Z`）时
  `float()` 抛 `ValueError`，整单转存被误判为失败（界面报「部分文件没能开始下载」）

## 2.0.1：深层目录下不了（配 netdisk-app 的修复）

插件本身没动（它只是个启动器），版本号是跟着「目录超过 6 层就整批下不了」那次修复一起发的
—— 改动都在 `netdisk-app/` 里，**随应用资源打包**，见下面「安装 → 装上之后」。

旧版的问题：展开目录写死 6 层且直接抛错，夸克分享 7 层就一个文件都下不到。
修完之后上限可配（设置里默认 32 层），到顶只跳过那棵子树；顺带补了「单目录超过 200 项
翻页」和「路径超过 260 字符走 `\\?\` 长路径」。

## 2.0.0：两个插件合并成一个

| 之前                       | 现在                        |
| -------------------------- | --------------------------- |
| `plugins/netdisk`「夸克网盘」 | `plugins/netdisk`「网盘下载」 |
| （迅雷那个还没进 InfoBoard） | 同一套插件 + 同一个窗口       |

id 仍然是 `netdisk`（工具区按 id 硬连的那条链路、以及 `%APPDATA%` 下已装的插件目录
都不用重建），变的只是**显示名**和它拉起来的那个程序：现在这个程序两家网盘都认。

为什么不拆成两个插件、两个窗口：用户要的从来不是"再开一个窗口"，而是"粘个链接就能下完"。
两家共用一套目录浏览、下载队列、直链自愈逻辑，拆开就得维护两份。

## 为什么是"启动器"，而不是把功能搬进插件

插件跑在 WebView 里，有三条硬限制正好卡住"下载"这件事：

| 限制 | 后果 |
| --- | --- |
| 受应用 CSP 约束（`connect-src` 只列了天气/B站等域名） | 发不出对网盘接口的请求 |
| 只能 import 白名单里的 4 个模块，没有文件写入能力 | 写不了下载的文件 |
| **只在面板打开时运行** | 面板一关，直链过期（5~10 分钟）就没人换链，大文件必然下不完 |

最后一条是最要命的，也是当初把主力从插件里搬出去的直接原因。
独立进程自己就能一直下、自己换链，关掉 InfoBoard 也不受影响。

另一条只在迅雷上体现得更狠：迅雷的接口要 `captcha_sign`，只能在**网页上下文**里发请求 ——
那需要一个真 WebView，插件本身的窗口反而是最不该放它的地方。

## 安装

1. 把 `dist-plugins/netdisk-2.1.0.ibplugin` 拖进 **设置 → 插件管理**
   （或把 `plugins/netdisk/` 拷到 `%APPDATA%\com.infoboard.tauri\plugins\netdisk\`，
   再点「重新加载插件」）
2. 需要 0.8.0 之后的应用（那时才有通用伴随程序命令 `companion_*`）；
   **2.1.0 起的插件包自带程序**，宿主需要认识 `companion.dir`（`core/companion.rs`
   的插件候选）。旧宿主会忽略这段声明，照旧用安装包里那份 —— 不会报错，只是热更新不生效。

> **装上之后**：程序在 `%APPDATA%\com.infoboard.tauri\plugins\netdisk\app\`，
> 宿主优先跑这份；安装包 resources 里那份 `netdisk-app/` 是没装插件时的兜底。
> 也就是说 2.1.0 之后：改 `netdisk-app/` 只需要重发 `.ibplugin`，不必重装应用。
> 从仓库直接跑（`npm run tauri dev`）时，宿主仍会取**修改时间最新**的副本，
> 所以开发时改的东西立刻生效。

## 用法

点工具区的 **☁️ 网盘下载** 图标 → 直接弹出下载器窗口（**不展开面板**，与截图插件同一套做法）。
启动失败（比如本机没装 Python）会弹一个原生错误框说明原因；
自动找不到入口时，展开面板可以手动指定一次 `netdisk-app/main.py` 的位置（会记住）。

下载器本体怎么用、两家网盘的协议细节与实测数据，见
[netdisk-app/README.md](../netdisk-app/README.md) 与 [docs/NETDISK.md](../docs/NETDISK.md)。

## 排错

| 现象 | 原因 / 解决 |
| --- | --- |
| 点图标没反应 | 十有八九是没装 Python（3.10+，自带 tkinter）。通常会弹错误框；也可以直接 `python netdisk-app/main.py` 看报错 |
| 「插件未声明命令」 | 应用版本太老，重新构建/安装；`src/__tests__/netdiskPlugin.test.ts` 会在 CI 提前拦下这类不同步 |
| 「当前应用里还没有通用启动器命令」 | 只在**兜底面板**里会出现（点图标是走 `netdisk_app_launch`，不需要它）。真遇到说明应用版本更老，`npm run tauri build` 后重装插件 |
| 迅雷链接报"需要 pywebview" | 用 InfoBoard 找得到的那个 Python 跑一次 `python -m pip install pywebview` |
| 下载中途显示「直链过期，换链中…」 | 正常自愈过程。一直停着说明换链失败，会带原因 |

## 它是怎么接的

**宿主端零改动**：合并两家网盘只换了背后那个程序，图标点击用的还是宿主原有的
`netdisk_app_launch`（`ToolSection` 里按 id 硬连的那一处），所以这个插件
**装上就能用，不需要重新编译应用**。

```
工具区点「☁️ 网盘下载」
      │  ToolSection 按 id 直接动作（与截图插件同一套做法）
      ▼
netdisk_app_launch  ──►  core::companion  ──►  pythonw netdisk-app/main.py
                          ├─ 找解释器：pythonw → python → pyw → py
                          ├─ 找入口：随包资源 → exe 上级 → cwd（取最新）
                          └─ 只认注册表里的 id（netdisk），借不了道去启动别的
```

下面这个面板是**兜底**（宿主正常时不渲染）：它用**宿主已有的**通用伴随程序命令
`companion_*`，于是自动找不到入口时可以在这里手动指定一次 `main.py` 的位置。
这些命令不是为这个插件新加的 —— `bili-dl` 早就在用了。

插件只声明了 5 个命令，权限面刻意收得很小：

```json
"tauriCommands": [
  "companion_status", "companion_launch", "companion_set_path",
  "companion_clear_path", "plugin:dialog|open"
]
```

它**拿不到** HTTP 转发、Cookie 读写、写文件这些能力 —— 那些能力曾经属于"应用内下载"，
在插件改成纯启动器之后就删掉了。

图标用宿主 `SVG_ICONS` 注册表里的 Lucide `cloud-download`，与截图 / 设置 / 翻译 /
API 一致，都是具名线性图标。
