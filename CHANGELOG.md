# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.8.0] - 2026-10-22

### Added

- **DeepSeek 网页 HUD**（外部插件 `plugins/deepseek/` + 命令 `hud_open_deepseek`，
  `src-tauri/src/plugins/hud/`）
  - 点工具区图标直接弹出一个常驻小窗，里面是 chat.deepseek.com **本身**
    （独立 webview，不是 iframe）
  - 为什么不用 iframe：站点用 `X-Frame-Options` / `frame-ancestors` 拒绝被嵌；
    而且主窗口实测只有 399px 宽，聊天区会被挤成一条缝
  - 贴主窗口左侧打开（左边放不下就换右侧），有标题栏、可缩放、置顶、不占任务栏；
    尺寸位置由 `tauri-plugin-window-state` 记住；已开着的直接唤到前面
  - 日志残留在 WebView2 自己的数据目录里，关掉应用再开不用重登
  - 安全：URL 是编译期常量 + 只认 https + 远端页面**不授予任何 Tauri 权限**
    （未配 `dangerousRemoteDomainIpcAccess`，页面调不了 invoke）
  - `ToolSection` 按 id 特判成"直接动作"，不展开面板（与网盘 / B 站下载器同一套做法）
  - **图标换成自绘的 `whale`**（Lucide 风格鲸鱼：24 网格 / 2px 描边 / 圆头圆角 /
    无填充，一条闭合轮廓 + 一个眼睛点），替代原来的 emoji 🐋 —— emoji 是彩色字形，
    粗细尺寸都不受控，和工具区其它线性图标不是一套。体量按真机截图调过：
    内容撑满 x 2.2–22.4 / y 5.6–20.6，与 `languages`、`camera` 对齐
  - 附带 `scripts/icon-preview.ps1`：把 SVG path 渲染成 PNG 的预览工具
    （GDI+ 直译 M/L/C/H/V/Z），画新图标时先看效果再落地
- **翻译插件重建为外部插件包**（`plugins/translate/`，v2.0.0 → **v2.2.0**）
  - 多引擎：小牛 / OpenAI 兼容（中转站、本地模型）/ DeepL / Google / MyMemory，
    失败按可用性自动换下一个，结果卡标明"这一条是谁翻的"
  - 历史（40 条）+ 收藏（100 条），点一条回填到翻译区；源语言按脚本自动识别；
    一键互换；长文按段落分片后再拼回
  - Key 仍只进 Windows 凭据管理器：新增凭据名 `translate-openai` / `translate-deepl`
    （`core/secrets.rs` 白名单同步扩了），前端与 `localStorage` 不留明文
  - v2.1 曾加过"截屏取字（全屏框选 → OCR）"，**v2.2 已整条移除**（见 Removed）
- 新增 `translate_web` 命令（`src-tauri/src/plugins/webtranslate/`）：**多引擎必须走
  Rust**，因为 WebView 的 CSP `connect-src` 是白名单，插件发不出对 DeepL / OpenAI /
  Google 的请求，插件侧也没有通用 HTTP 命令
- 新增 `npm run typecheck:plugins`（`tsconfig.plugins.json`）：`plugins/` 下的入口
  之前**完全没被类型检查过**（根 `tsconfig.json` 只 include `src`）

### Removed

- **翻译插件的截屏取字（OCR）整条移除**（插件 v2.1.0 → **v2.2.0**）
  - 插件侧：删掉「截屏取字」按钮、`grabScreen`、OCR 结果重排（`ocrToText` /
    `joinLineParts` / `box*` / `recognize`，约 120 行）、以及 manifest 里
    `translate_grab` / `ocr_recognize` / `ocr_is_ready` 三条命令声明
  - 宿主侧：删掉 `src-tauri/src/plugins/translate_grab/`（`translate_grab` /
    `translate_grab_image` / `translate_grab_submit` 三条命令）、
    `src/components/TranslateCaptureWindow.tsx`、`main.tsx` 里的
    `#/translate-capture` 路由、capabilities 里的 `translate-capture` 窗口
  - 自检里对应的 `translate_grab` 两段也一起去掉（只留 HUD）
  - **独立的截图插件不受影响**：`src/plugins/screenshot/`、`ocr_*` 命令、
    `screenshot_*` 命令、`screenshot-overlay` 窗口全部原样保留 ——
    它自己的「截图 + 识别文字」照常可用

### Changed

- **`translate` 不再是内置插件**：`src/plugins/translate/` 已删除，`src/plugins/index.ts`
  不再注册它 —— 不腾出这个 id，外部插件会因重名被跳过。设置面板里的小牛配置区保留，
  传输层搬到 `core/niutrans-bridge.ts`（和插件写同一份存储）

- **工具区显示名改短**：`plugins/netdisk` → 「夸克网盘」（原「网盘下载」）、
  `plugins/api-probe` → 「API」（原「API 测活」）
  - 只动**显示名**（`manifest.json` 与插件源码里的 `name`）。插件 id 与目录仍是
    `netdisk` / `api-probe`，所以 `%APPDATA%` 下的插件目录不用重建，
    `ToolSection` 里按 id 硬连的那两处（`netdisk_app_launch` / `apiprobe_app_launch`）也不受影响
  - 网盘下载插件 1.2.0 → **1.2.1**、API 插件 1.0.0 → **1.0.1**；
    `src/__tests__/` 里加了钉住这两个显示名的用例，防止"两边只改一处"

### Fixed

- **点 DeepSeek 图标整个应用卡死**（`app.log` 停在 `[HUD] 打开 DeepSeek` 之后，再无输出）：
  建窗时多做了一步 `restore_state` —— 它会拿 `tauri-plugin-window-state` 的两把锁
  （`RestoringWindowState` / `WindowStateCache`），并且在持锁期间调
  `available_monitors()` / `set_size()`，这两个都要回调主线程；同时命令还在
  worker 线程上查主窗口几何（`outer_position` / `outer_size` / `scale_factor`）。
  叠在一起把主线程锁死，整个窗口失去响应
  - 现在收敛成仓库里**已验证可用**的写法（`plugins::translate_grab` 同样是
    async 命令 + 建窗 + show，实测 3 秒内成功）：
    不碰 `restore_state`、不做任何跨线程窗口查询（位置改由前端把
    `screenX/screenY/outerWidth/outerHeight` 传进来，Rust 只做纯数学）、
    先 `visible(false)` 建好再 `show()`、去掉 `min_inner_size`
  - 补了排查日志：`[HUD] ①开始建窗 / ②建窗完成 Xms / ③已显示`，
    外加 6 秒看门狗 —— 万一再卡，日志会直接指明"卡在
    `WebviewWindowBuilder::build()`"
  - 新增 debug-only 自检（`src-tauri/src/selftest.rs`，release 构建不编译）：
    `INFOBOARD_SELFTEST=1 cargo run` 会把 HUD 建窗和取字窗口复用**真跑一遍**再退出。
    实测：HUD 建窗 **73ms**、窗口 `visible=true`、URL 落在
    `https://chat.deepseek.com/sign_in`；取字窗口冷启动 3337ms → 复用后 **300ms**
- **`cargo test` 编译不过**（``AppSpec`` doesn't implement `Debug`）：
  `plugins/companion` 的测试对 `Result<_, String>` 调 `unwrap_err()`，而
  `core/companion.rs` 的 `AppSpec` 没派生 `Debug` —— 整个 lib test 目标都起不来，
  连带 `pack` / `secrets` / `ocr` / `webtranslate` 的用例全部跑不了
  - 给 `AppSpec` 补 `#[derive(Debug, Clone, Copy, PartialEq, Eq)]`（字段全是
    `&'static str`，本来就是编译期常量）
  - 现在 `cargo test --lib` **89 项全绿**


- **网盘下载器点「解析」必崩，任何分享链接都解析不了**
  （`解析失败: TypeError: 'ShareCtx' object is not subscriptable`）：
  `ShareCtx` 只有 `__setitem__`、没有 `__getitem__`，于是适配器里
  `ctx["pwd_id"] = ...`（写）正常，`ctx["stoken"]`（读）直接抛 TypeError ——
  而且是**解析的第一步**就读，所以链接好坏都一样崩
  - 修法：给 `ShareCtx` 补上对称的 `__getitem__` / `__contains__`
  - **为什么之前测不出来**：`tools/smoke_download.py` 只测下载引擎，
    `parse` / `list_dir` / `resolve` 一个都不经过；协议部分一直只在真链接上手工验过
  - 新增 `netdisk-app/tools/smoke_adapter.py`：离线喂**真实形状**的假响应
    （不发任何请求、不需要账号），把 `parse → list_dir → resolve` 整条链盖住，
    含 41006 / 41008 / 23018 / 401 / 坏链接等提示的断言
  - 顺带修 `smoke_download.py` 的收尾打印：GBK 控制台下 `print("全部通过 ✅")` 每次都抛
    `UnicodeEncodeError`，**把"全部通过"变成了退出码 1** —— 自测脚本自己把结论弄反了
  - `tools/*.py` 与 `main.py` 一样设 `sys.dont_write_bytecode = True`，
    跑自测不再往源码树里留 `__pycache__`

## [0.7.0] - 2026-10-19

### Added

- **API 测活插件**（`plugins/api-probe/`）：工具区一个图标，拉起独立的
  「API 中转站测活工具」（`api_probe.py`，tkinter GUI、零第三方依赖；
  站点与多 Key 管理 / 模型列表探测 / 批量测速与流畅度 / 一键接入 Claude Code 与 Codex）
  - 它**不随应用打包**（有自己的仓库、自己在迭代），所以第一次点会展开面板让你指定
    一次 `api_probe.py` 的位置，之后记住；配好之后再点图标就是直接开
  - 图标用宿主注册表里的 Lucide `activity`（脉冲折线），与截图/设置/翻译/网盘下载
    一样是具名线性图标，不用 emoji
- **宿主新增"伴随程序"设施**（`src-tauri/src/core/companion.rs`）：把"找一个外部
  Python 程序并把它拉起来"的逻辑抽出来给多个插件共用（找解释器、找入口脚本、
  记住用户指定的路径），网盘下载器也改用它
  - **刻意不做"通用启动命令"**：每个程序一组命令（`netdisk_app_launch` /
    `apiprobe_app_launch`），插件只能启动自己那一个，借不了道去启动别的
  - 手动指定路径时校验**入口文件名**（必须是 `api_probe.py`），
    免得这个能力被当成"启动任意程序"的口子

### Changed

- `plugins/netdisk/app.rs` 瘦成两个薄封装，逻辑走 `core::companion`

## [0.6.0] - 2026-10-18

本次新增一条完整的下载链路：**独立软件「网盘下载器」+ InfoBoard 里的一键启动入口**。

### Added

- **网盘下载器（独立软件）** —— `netdisk-app/`，Python + Tkinter，**只用标准库、不需要 pip**
  - 自己的窗口和进程：下载不再依赖 InfoBoard 面板是否开着。这一点是硬需求 ——
    插件跑在 WebView 里只在面板打开时运行，而网盘直链只有 5~10 分钟有效期，
    面板一关就没人换链，大文件必然下不完
  - 功能：解析分享 → 目录浏览（双击进入 / 返回上级）→ 多选或整目录**递归**下载 →
    队列显示进度/速度/状态，可取消、双击打开所在文件夹；设置里可改保存目录、
    并发连接数、夸克登录态（带"关键项齐全"体检）
  - 引擎：Range 探测 → **动态分片队列 + 抢占式取片**（片数 = 连接数 × 32、单片 ≥ 256KB）
    → 各线程用自己的文件句柄随机写同一文件；**直链过期自愈**（撞上 401/403/404/412
    就重新解析分享、从未完成的分片继续，最多 5 次）；**429/503 全局退避**
    （首次 30 秒、翻倍、上限 5 分钟）；**慢分片抢占**（15 秒无数据就换条连接）
  - 换链做了**串行化**：直链一过期所有线程会同时撞上 401/403/412，各换各的会瞬间
    耗尽重试预算、还会重复解析分享；用"代次"判断，只有第一个发现的线程真正去换
  - **只实现夸克**（按要求）。蓝奏云/百度等未接入，原因见 `docs/NETDISK.md`
  - 自测工具：`tools/smoke_download.py`（本地 HTTP 服务真跑分片下载并逐字节比对、
    过期换链续传、不支持 Range 退回单连接，**不需要账号**）、
    `tools/probe_quark.py`（打真实接口验证路径与错误码层次）
- **插件改成纯启动器**：工具区点「☁️ 网盘下载」直接把独立软件拉起来，**不展开中间面板**
  （与截图插件同一套做法）。启动失败会弹原生错误框说明原因（最常见：本机没装 Python）
- **宿主新增 `netdisk_app_status` / `netdisk_app_launch`**：在固定位置找
  `netdisk-app/main.py`（资源目录 → 可执行文件上级 → 当前目录），用不弹黑框的解释器
  （`pythonw` → `python` → `pyw` → `py`）拉起。**刻意不给插件开放"启动任意程序"的能力**
  —— 插件只能触发"启动它"，不能指定启动什么。打包时把 `netdisk-app/` 作为资源带上
- 新增 `dialog:allow-message` 能力（启动失败要弹框，只在控制台打印等于没说）
- `docs/NETDISK.md`：设计、协议序列、并发实测数据、排错与调研来源

### Changed

- **插件的权限大幅收紧**：`tauriCommands` 从 13 个降到 **2 个**
  （只剩 `netdisk_app_status` / `netdisk_app_launch`）—— 这个插件再也拿不到
  HTTP 转发、Cookie 读写、写文件这些能力。入口体积 55KB → 4KB，包 23.3KB → 2.4KB
- **`tsconfig` 补上 `@/*` 路径映射**：插件文档让作者写
  `import type ... from '@/core/types'`，但没有这个映射时，只要有测试从 `src` 里
  import 了插件，`npm run build` 就会 TS2307 失败。补上后插件也一并被类型检查

### Notes

- 关于"免费高速"，要区分**按连接限速**和**账号级限速**：
  夸克属于前者（单连接常态 100~200KB/s，**多连接可叠加**，实测 512 并发 × 256KB
  可达 21~23.7 MB/s；但存在账号级总量天花板，512 → 1024 连接几乎不再涨）；
  百度属于后者（20~80KB/s，实测 4/8/16 并发总量不变），客户端无解，只有 SVIP 能提速。
  伪 SVIP User-Agent 一类"破解"手法已被官方封堵，本软件不做也不建议做。
- 夸克匿名档只能下约 50MB 以下的文件（超了报 `23018`），且**加并发无效**（按整体限速）；
  登录后同一路径可直接下 GB 级文件并能靠并发提速。

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

## [0.4.0] - 2026-10-16

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
