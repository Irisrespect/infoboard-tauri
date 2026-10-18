# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **独立软件：网盘下载器**（`netdisk-app/`，Python + Tkinter，只用标准库、不需要 pip）
  - 自己的窗口和进程，跑起来不受 InfoBoard 面板开关影响 —— 这解决了应用内下载最大的
    短板：插件**只在面板打开时运行**，而网盘直链只有 5~10 分钟有效期，面板一关就
    没人换链，大文件必然下不完；同时也绕开了应用 CSP（插件既不能直接发请求，
    也不能写文件）
  - 功能：解析分享 → 目录浏览（双击进入 / 返回上级）→ 多选或整目录**递归**下载 →
    队列显示进度/速度/状态、可取消、双击打开所在文件夹；设置里可改保存目录、
    并发连接数、夸克登录态
  - 引擎与 Rust 版同一套设计（片数 = 连接数 × 32、单片 ≥ 256KB、动态队列抢占取片、
    直链过期自愈、429/503 全局退避、慢分片抢占）。换链比插件版更可靠：进程自己就能
    重新解析，不需要谁来轮询驱动；且**换链做了串行化**（直链一过期所有线程会同时
    撞上 401/403/412，各换各的会瞬间耗尽重试预算）
  - **只实现了夸克**（按要求）
  - 自测工具：`tools/smoke_download.py`（本地 HTTP 服务真跑分片下载并逐字节比对、
    过期换链续传、不支持 Range 退回单连接）、`tools/probe_quark.py`（打真实接口）
- **插件的「打开网盘下载器」按钮**：工具面板顶部一个主按钮拉起独立软件，并显示可用
  状态（已就绪 / 没找到程序 / 没找到 Python 三种情况分别提示）；原来的"应用内下载"
  整块折叠到按钮下方，标题里直接写明它的限制
- **宿主新增 `netdisk_app_status` / `netdisk_app_launch`**：在固定位置找
  `netdisk-app/main.py`，用不弹黑框的解释器（`pythonw` → `python` → `pyw` → `py`）拉起。
  **刻意不给插件开放"启动任意程序"的能力** —— 插件只能触发"启动它"，不能指定启动什么。
  打包时把 `netdisk-app/` 一并作为资源带上

### Added（应用内下载路径）

- **网盘下载插件**（`plugins/netdisk/`）：输入分享链接 + 提取码 → 解析目录 → 多连接下载
  - 支持夸克网盘（免登录列目录 + 登录后转存取直链）、蓝奏云（免登录、不限速）、
    百度网盘（分享页解析 + 转存 + PCS 下载）、任意 http(s) 直链
  - 未接入的网盘（阿里云盘 / 123 / 天翼 / UC / 115 / 移动 / 迅雷 / 城通）会被明确拦下
    并说明原因，而不是回落到直链兜底去"下载"一个 HTML 页面
  - 设计与调研结论见 [docs/NETDISK_PLUGIN.md](docs/NETDISK_PLUGIN.md)
- **宿主的网盘后端**（`src-tauri/src/plugins/netdisk/`）——纯插件做不到这些：
  插件在 WebView 里受应用 CSP 限制（`connect-src` 只有天气/B站等域名），既不能
  `fetch` 网盘接口，也没有任何写文件能力
  - `netdisk_http_request`：带 Cookie 罐的 HTTP 转发；域名白名单 + **重定向每一跳
    重新校验**；Cookie 按可注册域分桶，`pan.baidu.com` 的 Cookie 不会发到夸克
  - `netdisk_download_start/status/list/cancel`：Range 探测 → **动态分片队列 + 抢占式
    取片**，并发写同一文件（Windows `seek_write` / Unix `write_at`，不需要"下完再合并"），
    分片内断点续传，连续无进展判定停滞
  - `netdisk_cookie_import/list/clear`、`netdisk_default_download_dir`、
    `netdisk_reveal_in_explorer`
- **测试**：Rust 侧 23 项（含**起本地 HTTP 服务真跑一遍 8MB 分片下载并逐字节比对**、
  **片数远多于连接数时的抢占式取片**、不支持 Range 时退回单连接、取消、域名白名单
  伪造后缀回归、分片计划边界、直链过期提示文案）；
  前端 17 项（用应用真实转译链路加载插件、校验每个 `invoke` 都在 `tauriCommands` 里
  声明且无多余声明、网盘识别路由、并发预算分配、acw_sc__v2 解挑战）
- **直链自愈（长任务的命门）**：网盘直链只有 5~10 分钟有效期，大文件必然中途过期。
  现在分片撞上 401/403/404/412 会把该分片**放回队首**、任务状态置 `expired` 并挂起；
  插件轮询到 `expired` 就重新解析分享、调新增的 `netdisk_download_relink` 送新直链，
  后端**从未完成的分片继续**（已下完的不重下）。最多自动换链 5 次，3 分钟等不到才失败。
  对应的集成测试用一个"发够 2MB 就一律 403"的本地服务端模拟过期，
  断言换链后逐字节一致、且计数正好等于文件大小（证明没有重下）。
- **限流退避（429/503）**：不是只退避当前分片，而是让所有 worker 一起静默
  （首次 30 秒、随后翻倍、上限 5 分钟）—— 限流是服务端对该账号/链路的，
  其它连接继续猛冲只会加重惩罚。
- **慢分片抢占**：某个分片 15 秒收不到一个字节就交回队列让别的连接试
  （已写下的字节仍然有效，重新排队后从断点续传）；同一分片最多重排 3 次。

### Fixed

- **夸克改走"免转存"直链（默认路线）**：`file/download` 直接吃分享的
  `fids` + `fids_token` + `pwd_id` + `stoken`，**不再往用户网盘写任何东西** ——
  不占空间（网盘满了也能下）、不用事后清理、少两次远端状态变更。
  原来的"转存 → 轮询 task → 取直链"降级为兜底路线。
  由此**小文件还能免登录下载**（匿名通道上限约 50MB，超过报 `code 23018`）。
- **并发策略改为按网盘区分**：不再用一个"线程数"滑块通吃所有网盘。
  百度**硬性锁 1 路** —— 它不是"多开没用"，而是"多开会主动招来惩罚"
  （BaiduPCS-Go 作者：调大线程极易触发限速，导致几小时至几天内账号接近 0 速）；
  夸克 64 / 蓝奏云 32。一次排多个文件时按文件大小分配 512 的连接预算
  （夸克按账号限总连接数），不再是每个文件都开满。
- **分片粒度 1MB → 256KB、片数 8× → 32× 连接数**：实测同样 512 并发下
  256KB/片 23.65MB/s、512KB/片 12.94、1MB/片 6.58；且"分片数必须 ≥ 并发数"，
  否则连接空转（626MB 用 2MB 分片只有 313 片，开 384 并发只跑出 4.9MB/s）。
- **Cookie 头加长度上限**：浏览器全部 Cookie（约 7.2KB）一起发会被服务端直接掐断
  连接（IncompleteRead / ChunkedEncodingError），现在会给出"只复制该网盘域 Cookie"
  的可照做报错。
- **夸克"多线程无效"的结论是错的，已纠正**：夸克是**按连接**给配额（单连接常态
  40–80 KB/s），多连接可叠加。此前把它当成账号级限速，是误信了 OpenList 文档
  "夸克下载慢是因为需要会员"——而 OpenList 的夸克驱动本身只做单路串流代理
  （`Concurrency: 3`），慢是它的架构问题。插件与文档均已改正。
- **分片从"静态等分"改为"动态队列 + 抢占式取片"**：快的连接下完一片就抢下一片。
  静态等分会让整体速度卡在**最慢的那条连接**上（尾部掉速/停滞）。
- **夸克 UA 前后一致**：取直链与下载统一用客户端 UA
  （`quark-cloud-drive/3.14.2 … Channel/pckk_other_ch`）。夸克会校验两处身份是否一致，
  混用浏览器 UA 会被判盗链而降速甚至 412。
- **并发上限 32 → 64**（默认仍 16，社区建议单文件 ≤64 路）。
- **直链过期不再傻等重试**：401/403/404/412 立即失败并提示"直链已过期，请重新解析"
  （夸克直链实测只有 5–10 分钟有效期）；429/503 提示调低并发。
- **新增 `cookieHost`**：网盘 API 域与 CDN 直链域常常不是同一个可注册域，
  按直链域名去 Cookie 罐里找会一无所获；现在由插件显式指定从哪个域取 Cookie。
- **`tsconfig` 补上 `@/*` 路径映射**：插件文档让作者写
  `import type { InfoBoardPlugin } from '@/core/types'`，而 tsconfig 里没有这个映射 ——
  只要有任何测试从 `src` 里 import 了插件，`npm run build` 就会 TS2307 失败。
  补上后插件也一并被类型检查。

### Notes

- 关于"免费高速"：**要区分"按连接限速"和"账号级聚合限速"**。
  夸克/蓝奏云/未限速直链属于前者，**多连接能叠加**（实测夸克 512 连接 22.33MB/s，
  1024 连接仅 23.20MB/s ⇒ 加连接有收益但有账号级总量天花板）；
  百度免费号属于后者（20–80KB/s，实测 4/8/16 并发总量不变），客户端无解，只有 SVIP 能提速。
  伪 SVIP User-Agent 一类"破解"手法已被官方封堵，本插件不做也不建议做。

## [0.5.0] - 2026-10-17

本次发布的两条主线：**插件包一键导入 / 卸载**，以及 **API Key 改存 Windows 凭据管理器**。

### Added

- **插件包导入 / 卸载**：设置 → 插件管理 支持把 `.ibplugin` 拖入虚线框安装，
  或走系统文件选择器；已安装列表带「卸载」按钮，同 id 覆盖安装即升级，
  全程不需要重启应用
  - Rust 侧新增 `install_plugin_package` / `list_installed_plugins` /
    `uninstall_plugin` / `purge_uninstalled_plugin`
  - 包内容按不可信输入处理：`enclosed_name()` 挡 zip slip、限制条目数与解压总量、
    `manifest.id` 白名单校验、解压到临时目录校验通过才原子改名（失败回滚）
  - 卸载分两步（先改名挪走，重新加载后再真删），规避 Windows 文件占用
- **插件打包脚本**：`node scripts/pack-plugin.mjs <插件目录>` → `dist-plugins/<id>-<version>.ibplugin`
  - 自带最小 zip 写入器（只用 Node 内置 zlib），不引第三方依赖
  - 与 Rust 侧双向格式契约测试（`include_bytes!` 读同一 fixture 真实安装一遍）
- **版本号单一来源校验**：`npm run version:check` / `version:sync`，
  以 `tauri.conf.json` 为准校验 `package.json` / `Cargo.toml`，并接入 pre-commit
- **凭据只读探针与跨重启回归测试**（`INFOBOARD_KEYRING_TEST=1` 开启）

### Changed

- **API Key 改存 Windows 凭据管理器**（服务名 `com.infoboard.tauri`，本机持久化）：
  和风天气 / 小牛翻译的 Key 不再明文写入 `localStorage` 或 `niutrans.json`；
  前端只写不读，拿不到明文；启动时自动迁移旧明文并清除
- **日志脱敏**：reqwest 错误经 `without_url()`，Key 只在发请求前由 Rust 用占位符注入
- **天气定时刷新改为仅窗口活跃时轮询**（原先隐藏到托盘后照跑）
- **主题色改用 React Context**，去掉渲染期改写模块级可变变量
- 全仓 prettier 规范化；修复此前**完全没生效**的 pre-commit 钩子
  （Husky 9 需要 `core.hooksPath` 指向 `.husky/_`，此前缺失）
- 版本号 `0.1.0` → `0.5.0`

### Fixed

- **B站信息补全失败被伪装成"没有结果"**：命令改 `Result<Option<..>, String>`，
  失败抛错并提示；失败不再写 30 分钟负缓存，改 60s 退避重试
- **截图拖拽时指针移出窗口松手会卡死**（永远停在 `selecting`）
- **`isEmoji` 判错**：`👋🏽` / `🏳️‍🌈` / `🇨🇳` 等组合 emoji 被判成非 emoji，
  两个汉字反被判成 emoji
- **错误信息渲染成 `[object Object]`**：新增统一格式化
- **标题栏最大化状态乐观翻转**，改为回读真实状态
- **紫外线恒显示 `--`**：缺数据时显示「暂无」
- **`bilibiliCache` 只增不减**：加容量上限与淘汰策略
- **插件注册容错**：单个插件失败不再中断整批，`initPromise` 失败后可恢复
- **`useLocationSearch` 防抖定时器未清理**、**B站空标题参与匹配**、
  **OCR/B站字节截断 panic**、**设置读取零类型校验**、**副作用写在 `setState` updater 内**
- **拖拽监听随安装状态重建**导致丢事件

### Documentation

- 修正插件文档中与代码不符的说明：import 路径、`@tauri-apps/api/event` **已不可用**、
  `tauriCommands` 必须声明否则 invoke 被拒、重新加载而非重启
- 新增 `docs/release-notes-v0.5.0.md`、`REMAINING_ISSUES_STATUS.md`

## [Unreleased]

### Added

- **外部插件系统**: 支持热插拔插件，无需修改核心代码即可添加新功能
  - 新增 `PluginLoader` 类处理外部插件动态加载
  - 新增 Rust 侧 `scan_external_plugins` 命令扫描 `plugins/` 目录
  - 新增 `ExternalPluginMeta` 类型定义插件元数据
  - 扩展 `PluginManifest` 支持版本、作者、描述字段
  - `InfoBoardPlugin` 新增 `type` 和 `sourcePath` 字段区分内置/外部插件

- **插件开发工具**: 完整的外部插件开发支持
  - 新增 `docs/PLUGIN_TUTORIAL.md` 插件开发教程
  - 新增 `plugins/hello-world/` 示例插件
  - 新增 `reloadPluginSystem()` 方法支持插件热重载

- **API 增强**:
  - `PluginRegistry` 新增别名方法: `get()`, `getAll()`, `getBySection()`
  - `core/index.ts` 导出 `PluginLoader` 和 `reloadPluginSystem`

### Changed

- **PluginHost 重构**: 拆分内置插件和外部插件加载逻辑
  - `importPlugins()` 拆分为 `importBuiltinPlugins()` 和 `importExternalPlugins()`
  - 内置插件自动标记 `type: 'builtin'`
  - 外部插件自动标记 `type: 'external'`

- **项目结构调整**:
  - `src/plugins/` → 内置插件目录
  - 新增 `plugins/` → 外部插件目录
  - `src-tauri/src/plugins/` 新增 `loader.rs` 模块

### Documentation

- 更新 `README.md` 添加外部插件系统说明和快速开始
- 更新项目结构文档包含 `plugins/` 目录

## [之前版本]

请参考 Git 提交历史
