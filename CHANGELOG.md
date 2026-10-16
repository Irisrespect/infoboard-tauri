# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
