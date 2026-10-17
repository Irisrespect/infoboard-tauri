# InfoBoard v0.5.0 — 插件一键导入与卸载

本次发布的核心是**插件包导入 / 卸载**：不再需要用户去 `%APPDATA%` 找插件目录，
把 `.ibplugin` 文件拖进设置面板即可安装，列表里点一下即可卸载。

> ⚠️ **从旧版本升级的用户请注意**：如果你之前把和风天气 API Key 配在
> 更早的版本里（Key 存在 localStorage 的那批），升级后可能需要**重新配置一次**。
> 从此版本起 Key 存在 Windows 凭据管理器，重启电脑不会再丢。
> 详见下方「凭据持久化」。

## ✨ 新增

- **插件包导入 / 卸载**
  - 设置 → 插件管理：把 `.ibplugin` **拖进虚线框**即可安装，或点框选文件走系统选择器
  - 已安装插件列表带「卸载」按钮；同 id 的包会覆盖安装（等于升级）
  - 安装后自动重新加载插件系统，**不需要重启应用**
  - 导入失败会直接展示原因（包损坏 / 缺 manifest.json / id 非法 / 包过大等）
- **插件打包脚本**：`node scripts/pack-plugin.mjs <插件目录>` → `dist-plugins/<id>-<version>.ibplugin`
  - 自带最小 zip 写入器（只用 Node 内置 zlib），不引第三方依赖
- **版本号单一来源校验**：`npm run version:check` / `version:sync`，并接入 pre-commit
  （改动 `tauri.conf.json` / `package.json` / `Cargo.toml` 时自动校验，漂移直接拒绝提交）

## 🔒 安全

- **API Key 改存 Windows 凭据管理器**：和风天气 / 小牛翻译的 Key 不再明文写进
  localStorage 或 `niutrans.json`，前端**只写不读**、拿不到明文
  - 启动时自动把旧版明文迁移进凭据管理器，并从 localStorage 删除
- **日志脱敏**：reqwest 错误经 `without_url()` 处理，Key 只在发请求前由 Rust 注入占位符，
  日志与界面里不再出现完整 Key
- **外部插件命令护栏**：`manifest.json` 的 `tauriCommands` 未声明的命令一律拒绝（fail-closed）
- **`tauri-plugin-dialog` 只开放 `allow-open`**，capability 维持最小集

## 🐛 修复

- **天气定时刷新不看窗口活跃**：隐藏到托盘后仍会定期请求，现改为仅窗口活跃时轮询
- **紫外线恒显示 `--`**：和风免费版/部分地区缺 `uvIndex` 字段，现显示「暂无」而非伪装成破样式
- **B站信息补全失败被伪装成"没有结果"**：命令改 `Result<Option<..>>`，
  失败会抛错并提示，不再与"确实没匹配"混为一谈；失败也不再写 30 分钟负缓存
- **截图拖拽时指针移出窗口松手会卡死**：补 `document` 级 `pointerup`/`pointercancel` 兜底
- **`isEmoji` 判错**：`👋🏽`、`🏳️‍🌈`、`🇨🇳` 等组合 emoji 被判成非 emoji，两个汉字反被判成 emoji
- **错误信息渲染成 `[object Object]`**：新增统一格式化，支持 `{message}` / `{error}` / `{code}` 形状
- **标题栏最大化状态乐观翻转**：改为回读真实状态，图标不再与窗口不一致
- **`bilibiliCache` 只增不减**：加容量上限（先淘汰过期、再淘汰最旧）
- **插件注册容错**：单个插件注册失败不再中断整批；`initPromise` 失败后可恢复
- **B站空标题参与匹配**、**OCR/B站字节截断 panic**、**设置读取零类型校验**、
  **副作用写在 setState updater 内**、**`useLocationSearch` 防抖定时器未清理** 等

## 🎨 界面

- 主题色改用 React Context，去掉渲染期改写模块级变量（并发渲染下会串色）
- 右键菜单钳制到视口内并支持 Esc 关闭；纯图标按钮补齐 `aria-label`
- 刷新按钮改为等真实结果再提示，不再无条件报成功
- 插件图标改用 Unicode 属性判断，组合 emoji 与中文都能正确显示

## 📦 安装包

| 文件                            | 说明                |
| ------------------------------- | ------------------- |
| `InfoBoard_0.5.0_x64-setup.exe` | NSIS 安装包（推荐） |

- 系统要求：Windows 10/11 x64 + WebView2 运行时（Win10/11 一般已自带）
- **安装包已内置截图 OCR 引擎**：`RapidOCR-json.exe` 与 onnx 识别模型随包安装到程序目录下的
  `rapidocr/`，装完即可用，无需额外下载

## 🔑 凭据持久化（重要）

从本版本起，API Key 存在 **Windows 凭据管理器**（服务名 `com.infoboard.tauri`），
条目为「本机持久化」，**重启电脑不会丢**。

若你曾用过把 Key 存在 localStorage 的旧版本，并遇到"重启后 Key 消失"：
那是因为 localStorage 会随 WebView2 用户数据被清掉（清缓存、修复/重装 WebView2 等），
而旧版没有迁移逻辑。本版本已改为凭据管理器存储。

## 📚 文档

- `docs/PLUGIN_QUICKSTART.md`、`docs/PLUGIN_API.md`、`docs/PLUGIN_TUTORIAL.md` 已修正
  与代码不符的说明（import 路径、`@tauri-apps/api/event` 不可用、`tauriCommands` 必须声明、
  重新加载而非重启）
- 新增插件包导入 / 卸载与打包脚本用法

## 🙏 已知限制

- 外部插件仍运行在主窗口内，权限等同于应用本身；`tauriCommands` 只是护栏不是安全边界
  （插件可直接用 `window.__TAURI_INTERNALS__.invoke` 绕过），真隔离需要 iframe/Worker 沙箱
- `manifest.permissions` 目前无消费方（保留字段，待产品决策）
- CSP 仍保留 `script-src 'unsafe-eval'` —— 外部插件运行时依赖它执行转译后的代码
