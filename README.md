# InfoBoard

桌面信息面板 — 基于 [Tauri 2](https://tauri.app/) 的插件化仪表盘，聚合 AI 用量、待办、天气、媒体控制、邮件通知、截图 OCR 等。

![Platform](https://img.shields.io/badge/platform-Windows-blue)
![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB)
![License](https://img.shields.io/badge/license-MIT-green)

## 功能

| 模块            | 说明                                                                                |
| --------------- | ----------------------------------------------------------------------------------- |
| **灵动岛**      | 系统媒体会话（SMTC）控制、B 站信息补充、可选本地 MusicPlayer 歌词桥、邮件验证码通知 |
| **OpenCode Go** | OpenCode / MiniMax 用量查询，Cookie 刷新                                            |
| **天气**        | 定位 + 公开天气 API（可配置和风 Key）                                               |
| **待办**        | 本地待办列表（localStorage）                                                        |
| **翻译**        | 小牛翻译 API                                                                        |
| **截图**        | 全屏捕获、区域框选、剪贴板；集成 RapidOCR 文字识别                                  |
| **设置**        | 主题色、开机自启、API Key、邮箱账户、插件开关                                       |
| **🔌 外部插件** | 热插拔插件系统，无需修改核心代码即可添加新功能                                       |

## 插件系统

InfoBoard 支持**外部插件热加载**，开发者可以编写独立插件包而无需修改核心代码。

### 快速开始

1. 在 `plugins/` 目录创建插件文件夹
2. 编写 `manifest.json` 和入口文件
3. 重启应用自动加载

**示例：** 查看 [`plugins/hello-world/`](plugins/hello-world/) 示例插件

**完整教程：** 阅读 [插件开发指南](docs/PLUGIN_TUTORIAL.md)

### 插件目录结构

```
plugins/
├── hello-world/          # 示例插件
│   ├── manifest.json     # 插件元数据
│   └── index.tsx         # 入口文件
└── your-plugin/          # 你的插件
    ├── manifest.json
    └── index.tsx
```

## 技术栈

| 层面     | 选型                                  |
| -------- | ------------------------------------- |
| 桌面框架 | Tauri 2                               |
| 前端     | React 19 + TypeScript（strict）+ Vite |
| 后端     | Rust 2021                             |
| 样式     | Tailwind CSS v3                       |
| 状态     | Zustand                               |
| 图标     | lucide-react                          |

## 环境要求

- **Windows 10/11**（媒体控制、OCR 二进制当前面向 Windows）
- [Node.js](https://nodejs.org/) 18+
- [Rust](https://rustup.rs/) stable（`rustup default stable`）
- [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)（编译 Tauri 需要）
- WebView2（Win10/11 一般已自带）

## 快速开始

```bash
# 安装前端依赖
npm install

# 开发模式（Vite 热更新 + Rust）
npm run tauri dev
# 或
npx tauri dev
```

类型检查：

```bash
npm run typecheck
```

## 生产打包

```bash
# 构建前端 + 编译 Rust + 生成安装包
npx tauri build
```

成功后产物大致位于：

```
src-tauri/target/release/bundle/
├── msi/          # Windows 安装包
├── nsis/         # NSIS 安装程序（若启用）
└── ...
```

可执行文件：

```
src-tauri/target/release/infoboard-tauri.exe
```

> 首次打包会下载/编译大量 Rust 依赖，耗时较长。若访问 crates.io / npm 不稳定，可配置系统代理后重试。

## 项目结构

```
├── src/                      # 前端
│   ├── components/           # 标题栏、分区布局、截图浮层等
│   ├── core/                 # 插件宿主、注册表、加载器、Toast、事件总线
│   ├── plugins/              # 内置插件（天气、待办、灵动岛、截图…）
│   ├── stores/               # 全局 Zustand
│   └── tauri-shim.ts         # 兼容层（invoke 封装）
├── src-tauri/                # Rust 后端
│   ├── src/core/             # 窗口、托盘、自启、定位、Toast
│   ├── src/plugins/          # 各插件 command 实现 + loader（插件扫描器）
│   ├── binaries/rapidocr/    # OCR 引擎与模型（随仓库提供）
│   └── capabilities/         # Tauri 权限
├── plugins/                  # 外部插件目录（用户可添加自定义插件）
│   └── hello-world/          # 示例插件
├── docs/                     # 文档
│   └── PLUGIN_TUTORIAL.md    # 插件开发教程
├── package.json
└── vite.config.ts
```

## 配置说明

大部分选项在应用内 **设置** 面板配置，例如：

- MiniMax API Key（用量查询；也可设环境变量 `MINIMAX_API_KEY`）
- 和风天气 Key（可选）
- 小牛翻译 appId / appKey
- IMAP 邮箱（用于验证码通知；密码仅本地保存）

**可选本地服务：**

| 服务        | 地址                     | 用途                                            |
| ----------- | ------------------------ | ----------------------------------------------- |
| MusicPlayer | `http://127.0.0.1:17831` | 歌词与精确进度（未启动时自动退避，不影响 SMTC） |

## 开发命令

| 命令                            | 作用             |
| ------------------------------- | ---------------- |
| `npm install`                   | 安装前端依赖     |
| `npm run dev`                   | 仅 Vite 前端     |
| `npx tauri dev`                 | 完整桌面开发模式 |
| `npm run build`                 | 前端生产构建     |
| `npx tauri build`               | 桌面应用打包     |
| `npm run typecheck`             | TypeScript 检查  |
| `cargo test`（在 `src-tauri/`） | Rust 单元测试    |

## 许可

MIT

## 链接

- 仓库：https://github.com/truthhalldingzhen-ux/infoboard-tauri
