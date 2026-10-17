# REMAINING_ISSUES.md 核实与修复报告

> 本文档是 `REMAINING_ISSUES.md`（生成于 2026-10-17）的**逐条核实结果**。
> 该清单里的大部分条目在更早的提交中已经修掉，只是清单没有同步更新。
> 下文给出：**已修复（附证据）** / **本轮新修复** / **仍未修复（附原因）**。
>
> 核实方式：读当前源码 + 跑测试（`vitest run` 118 passed、`cargo test` 61 passed）+ `tsc --noEmit` 0 error。

---

## 一、原清单中「已经修好」的条目（无需再动）

| 编号 | 原问题 | 当前状态与证据 |
| --- | --- | --- |
| **P0-1** | 外部插件整条链断裂（扫不到目录、返回相对路径、前端 import 失败、无文件通道） | **已修**。`plugins/loader.rs:84` 扫描 `app_data_dir()/plugins`；`entryPath` 返回绝对路径；不再走 `import()`，改为 Rust 读源码 → `pluginRuntime.ts` 用 sucrase 转译后在受控 `require` 环境执行。`pluginRuntime.test.ts` 里有仓库自带 3 个示例插件的**真实加载**测试（含 `.plugin-template`）。 |
| **P0-4** | 最小化后无法从托盘/快捷键恢复 | **已修**。`core/window.rs:35` `set_main_visible()` 先 `unminimize()` 再 `show()+set_focus()`；`decide_toggle()` 单独判断 `is_minimized()`，单测覆盖 `decide_toggle(true, true) == Show`。 |
| **A3** | 和风/MiniMax Key 明文存 localStorage | **已修**。Key 改存 Windows 凭据管理器（`core/secrets.rs` + `settings/secrets.ts`），前端**只写不读**；启动时 `migrateLegacySecrets()` 把旧明文迁走并从 localStorage 删除；`minimaxApiKey` 之类残留字段直接清除。 |
| **A4** | API Key 随 reqwest 错误 URL 进日志 | **已修**。`http_proxy.rs` 所有 `map_err` 都过 `e.without_url()`；Key 用 `{{QWEATHER_KEY}}` 占位符，只在发请求前由 Rust 注入，日志/错误里永远是替换前的 URL；`test_no_api_key_in_error` 覆盖。 |
| **A5** | capabilities 权限过宽 | **已修**。`capabilities/default.json` 现在只有 4 项：`core:default`、`core:event:default`、`core:webview:allow-internal-toggle-devtools`、`clipboard-manager:allow-write-text`。`store`/`autostart`/`global-shortcut`/`clipboard-manager:allow-read-text` 已全部移除。 |
| **B5** | 日志只追加、无轮转无上限 | **已修**。`core/app_log.rs`：单文件 5 MB 上限 + 轮转为 `app.log.1`（保留一份）；单条消息 8 KB 上限并按字符边界截断。 |
| **B7** | 缺少单实例 | **已修**。`lib.rs:29` 注册 `tauri_plugin_single_instance`，且在插件注册顺序上排第一。 |
| **C4** | OCR / bilibili 字节截断 panic | **已修**。改为 `core::text::truncate_bytes()`（按 `is_char_boundary` 回退），`text.rs` 单测覆盖 `你好世界` 这类多字节串。 |
| **C5** | B站空标题参与匹配 | **已修**。`find_best_match()` 跳过归一化后为空的标题；`has_bvid()` 过滤缺 bvid 条目；4 个针对性单测。 |
| **D4** | initPromise 永久缓存、一个插件抛错中断整批 | **已修**。`PluginHost.tsx` 失败不缓存 promise（`attempt.catch` 里清空）；`PluginRegistry.registerAll()` 逐个 try/catch，单个失败不影响其余；`unregister/clear` 的 `onDestroy` 也各自 try/catch。 |
| **E2** | 歌词进度用 RAF 每帧 setState | **已修**。进度改为 ref + `getPosition()` 按需读取，`LyricsView` 只在**换行时** setState，`PlaybackProgress` 250 ms 一次；窗口不活跃时停止插值。 |
| **F1** | 设置读取零类型校验 | **已修**。`settingsStorage.ts` 的 `sanitizeSettings()` 逐字段收敛，脏数据回退默认值；`settingsStorage.test.ts` 覆盖。 |
| **F2** | 写盘与事件派发在 setState updater 内 | **已修**。`useSettings.ts` 改为纯 `setSettings(next)` + updater 外统一 `commit()`；写盘失败会弹 toast 而不是静默。 |
| P2 错误吞掉 1、2 | bilibili 账户级失败仍返回成功；media 失败归一为 `Ok(false)` | **已修**。`media_send_command` 返回 `Result<bool, String>`（`parse_send_command_output` + 回归测试）；bilibili 见「本轮新修复 6」。 |
| P2 死代码 | `toast.rs` / `cities.ts` / `getRelativeTime.ts` / `plugin-system/` | **已删除**（`Test-Path` 全部 False）。注意 `PluginHost.tsx` **不是**死组件——`InfoSection`/`ToolSection`/`SettingsPanel`/`core/index.ts` 都在用。 |
| P2 契约 3 | DevTools 命令名错误 | **已修**。`core/devtools.ts` 用 `plugin:webview\|internal_toggle_devtools`，`devtools.test.ts` 锁定。 |
| P2 契约 4 | tsconfig exclude 造成检查盲区 | **已修**。`tsconfig.json` 只有 `include: ["src"]`，无 `exclude`。 |
| P2 安全 1 | http_proxy 白名单可绕过（默认跟随 10 跳重定向） | **已修**。改为 `redirect::Policy::custom`，**每一跳重新校验白名单**，最多 5 跳。 |
| P2 安全 3 | log_append_file 无 level 白名单/换行过滤 | **已修**。`normalize_level()`（白名单外归一为 info）+ `sanitize_message()`（`\r\n`→空格）；有"伪造多行日志"回归测试。 |
| P2 安全 4 | Google Fonts 被 CSP 拦 | **已修**。改为自托管 `public/fonts/inter-latin-var.woff2` + `@font-face`（`styles/fonts.css`）。 |
| P2 安全 5 | `bundle.targets="all"` | **已修**。改为 `["nsis"]`。 |
| P2 性能 1 | 多处轮询无 visibilityState 判断 | **大部分已修**。`useMediaControl`、`useMusicPlayerBridge` 都由 Rust 的 `window:visibility` 事件驱动（WebView2 `hide()` 后 `document.visibilityState` 不变，所以不能用它）。**天气是漏网的 → 见本轮新修复 1**。 |
| P2 体验 1 | 刷新按钮恒弹成功 toast | **已修**。`refresh()` 返回 `Promise<boolean>`，`handleRefresh` 等真实结果再提示。 |
| P2 体验 3 | 右键菜单无边界钳制、无 Esc | **已修**。`components/contextMenu.ts` 纯函数钳制 + `App.tsx` 监听 Esc/点击关闭。 |
| P2 体验 4 | 整卡 onClick 吞内部交互点击 | **已修**。`ScreenshotOverlay` 等内部按钮统一 `stopPropagation()`。 |
| P2 体验 6 | 纯图标按钮缺 aria-label | **已修**。`TitleBar` 4 个图标按钮都有 `aria-label`。 |

---

## 二、本轮新修复

### 1. 天气定时刷新不看窗口活跃状态（「性能 1」漏网项）

- **文件**：`src/plugins/weather/useWeather.ts`
- **问题**：`setInterval(fetchWeather, REFRESH_INTERVAL)` 无条件启动，隐藏到托盘后仍会定期穿一次
  WebView → `http_proxy` → reqwest；与「隐藏后停止轮询」的验证项相悖（媒体轮询早已这么做）。
- **修复**：引入 `useWindowActive()`；不活跃时不创建定时器，恢复活跃时立即补一次
  （`fetchWeather(undefined, { silent: true })`，`silent` 不切 `loading`，避免卡片闪回骨架屏）。

### 2. 紫外线恒显示 `--`

- **文件**：`src/plugins/weather/WeatherCard.tsx`、新增 `src/plugins/weather/display.ts`
- **问题**：`data.uvIndex || '--'`——`/v7/weather/3d` 的 `daily[0].uvIndex` 在免费版/部分地区本来就缺字段，
  渲染成 `--` 看起来像"样式坏了"而不是"没有数据"。
- **修复**：抽出纯函数 `formatUvIndex()`：有值原样展示，无值显示「暂无」并用次级色 + 小字号。
- **测试**：`src/__tests__/weatherDisplay.test.ts`（含"结果里不得出现 `--`"的断言）。

### 3. bilibiliCache 只增不减

- **文件**：新增 `src/plugins/dynamic-island/biliCache.ts`，改 `useMediaControl.ts`
- **问题**：`bilibiliCache` 只 `set` 不 `delete`，换歌就涨；负缓存（无结果/失败）也照样占位。
- **修复**：`selectEvictions()` 纯函数——先淘汰**已过期**条目，仍超限再按 `expires` 升序淘汰最旧的；
  上限 `MAX_BILI_CACHE_ENTRIES = 100`。
- **测试**：`src/__tests__/biliCache.test.ts`（7 例，含"不误伤仍有效条目""淘汰数量刚好不超限"）。

### 4. 截图拖拽时指针移出窗口松手 → 卡在 `selecting`

- **文件**：`src/plugins/screenshot/ScreenshotOverlay.tsx`
- **问题**：`onMouseUp` 挂在覆盖层 div 上；拖到窗口外松手时收不到事件，永远停在 `selecting`
  （之后按左键也不响应，等于截图卡死）。
- **修复**：`state === 'selecting'` 时在 `document` 上监听 `pointerup` / `pointercancel`
  （外加 `window.blur` 兜底），用 `startPosRef`/`currentPosRef` 取最新坐标结算；小于 5px 视为误触回到 `idle`。

### 5. `useLocationSearch` 防抖 timer 无清理

- **文件**：`src/plugins/weather/useLocationSearch.ts`
- **问题**：`clearTimeout` 只发生在 `search()` 内部；组件卸载后 300 ms 的定时器仍会触发，
  在已卸载组件上 setState，并在窗口关闭途中白发一个请求。
- **修复**：新增卸载 effect，清 `timerRef` 并 `abort()` 在途请求。

### 6. B站信息补全失败被伪装成"没有结果"

- **文件**：`src-tauri/src/plugins/bilibili_info/mod.rs`、`src/plugins/bilibili-info/bridge.ts`、
  `src/plugins/dynamic-island/useMediaControl.ts`
- **问题**：命令签名是 `-> Option<BilibiliVideoInfo>`，前端再 `catch → return null`，
  于是"B站接口不通 / 被风控 / 超时"与"确实没这个视频"完全无法区分，用户只看得到"没有结果"。
- **修复**：
  - Rust：改为 `Result<Option<BilibiliVideoInfo>, String>`——`Ok(None)` = 查了但没匹配，
    `Err` = 请求/解析失败（客户端、搜索、详情三处都向上传，同时保留 `app.log` 记录）。
  - 前端 bridge：失败时 **抛错**并派发 `bilibili-enrich-error` 事件（供界面提示），不再 `return null`。
  - `useMediaControl`：失败**不再写负缓存**（否则一次网络抖动会让封面空 30 分钟），
    改为 60 s 退避重试（`biliRetryAfter`）；**确实没有匹配**仍然写 30 分钟负缓存。
- **测试**：`src/__tests__/bilibiliBridge.test.ts` 锁定三种结果的区分与事件派发。

---

## 三、仍未修复的条目（及原因）

### 1. CSP `script-src 'unsafe-eval'`

- 清单建议移除 `unsafe-eval`，但**当前架构依赖它**：外部插件运行时要用 `new Function(...)`
  执行转译后的代码（`src/core/pluginRuntime.ts:119`）。直接移除会让外部插件全废。
- 想真正收紧需要先换方案（预打包插件为 `.js`、或改用 Web Worker 类隔离），属于 P0-1「方案 B」的工程量。
- **建议**：保留并在 `tauri.conf.json` 加注释说明原因，或明确接受"外部插件 = 完全可信代码"的模型。

### 2. `permissions` 字段无消费方（契约 1）

- 核实证据：全仓 `grep permissions` 只命中 1 处 —— `src/core/types.ts:88` 的类型声明本身，
  **没有任何读取方**；对照之下 `tauriCommands` 在 `PluginLoader.ts:72` 被传给
  `createPluginModules()` 并真正生效（有 `pluginRuntime.test.ts` 的 fail-closed 测试）。
- 结论：manifest 里的 `permissions: []` 没有任何运行时校验，实际生效的只有 `tauriCommands` 白名单。
- 要么删字段，要么实现校验——**需要产品决策**（删掉会影响插件作者预期）。
- 注意 `pluginRuntime.ts` 的注释已写明：`tauriCommands` 只是**护栏不是安全边界**
  （插件可直接用 `window.__TAURI_INTERNALS__.invoke` 绕过）。
- 契约 2（`_template` 与真实插件不一致）**已修**：`src/plugins/_template/index.ts` 的导出形状与
  `weather/index.ts` 一致，且 `.plugin-template/index.tsx` 有真实加载测试。

### 3. 截图 base64 双份驻留（性能 2）

- 需改成"Rust 返回临时文件路径 + `convertFileSrc`"或流式传输；改动较大，风险高于收益
  （当前未观测到内存问题）。

### 4. 文案硬编码无 i18n（体验 7）

- 全仓中文硬编码。提取 `src/i18n/zh-CN.ts` 是大范围机械改动，单独一个 PR 更合适。

### 5. 「小项（10）」等未展开条目

- 原清单「体验 8」指向 `CODE_REVIEW.md` 的「小项（10）」，本报告未逐条核对，
  需要时可从 `CODE_REVIEW.md` 再拉一次清单。

---

## 四、本轮验证结果

```
npx tsc --noEmit          → 0 errors
npx vitest run            → 19 files / 118 tests passed   （新增 3 个测试文件 / 16 例）
cargo test                → 61 passed, 0 failed
cargo check               → Finished（无新增 warning）
```

### 原始验证清单对照

- [x] 最小化后可从托盘恢复 —— `set_main_visible` 先 `unminimize()`，`decide_toggle` 有单测
- [x] 双击启动时只有一个实例 —— `tauri_plugin_single_instance` 已注册
- [x] 日志文件大小可控 —— 5 MB 轮转 + 8 KB 单条上限
- [x] 敏感 Key 不在 localStorage —— 改存凭据管理器，旧值启动时迁移并删除
- [x] 错误日志不含完整 API Key —— `without_url()` + 占位符注入，有测试
- [x] 中文错误消息不会导致 panic —— `truncate_bytes` 按字符边界，有测试
- [x] 插件加载失败不影响其他插件 —— `registerAll` 逐个容错 + `initPromise` 失败可恢复
- [x] 隐藏到托盘后轮询停止 —— 媒体（已修）+ **天气（本轮修）**；截图/OCR 为按需触发

---

*核实时间：2026-10-17*
*基于 `REMAINING_ISSUES.md` 逐条核对当前源码*
