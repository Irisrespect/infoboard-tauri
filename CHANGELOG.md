# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
