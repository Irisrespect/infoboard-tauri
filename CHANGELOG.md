# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
