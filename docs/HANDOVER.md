# InfoBoard 交接文档：遗留问题

> 基线：`master` 上 `c00df41`（审计时）→ 当前 `6abf2a2`，其间 19 个提交。
> 来源：`CODE_REVIEW.md`（只读审计）+ 之后的逐项核实与修复。
> 本文只写**还没解决**的事、已知限制和上手信息。已修复的条目见文末"已完成"。
>
> **2026-10-16 更新**：第 2 节的 P1-a / P1-b / P1-c / P1-d / P2 日志 / P2 安全加固 /
> P2 外部插件 / 第 3 节告警清理均已修复，逐项证据见下面第 0 节。
> 仍**未**处理的只有：i18n、外部插件沙箱隔离、旧日志文件（见 0.3）、
> 以及第 4 节列出的未验证项。

## 0. 本轮修复记录（2026-10-16）

### 0.1 提交清单（`6abf2a2` → `4b6d377`）

| 修复                                                               | 提交      |
| ------------------------------------------------------------------ | --------- |
| P1-b 隐藏到托盘后停止轮询与歌词逐帧重渲染                          | `2b57007` |
| P1-d http_proxy 去掉硬编码本机代理端口（逻辑合并到 `core/net.rs`） | `ddc595f` |
| P2 日志：重复落盘、`log_append_file` 入参校验、可读时间戳          | `d01e430` |
| P1-a API Key 改存 Windows 凭据管理器                               | `af898ea` |
| tsc 不再排除 dynamic-island / screenshot / translate / _template   | `f377010` |
| 第 3 节编译告警 + clippy + MSRV（1.77 → 1.80）                     | `5849486` |
| P2 死代码删除                                                      | `2d1d89c` |
| P2 错误被吞（`media_send_command` 等）                             | `6be6165` |
| ErrorBoundary（应用级 + 插件级）                                   | `3de2b92` |
| F2 设置副作用移出 updater                                          | `b190754` |
| 待办截止日期校验 + 保存失败提示                                    | `ca1357e` |
| P1-c + CSP 收紧 + 字体自托管                                       | `62597bd` |
| capability `windows` 字段 + `custom-protocol` 生产开关             | `75798b6` |
| 插件 `tauriCommands` 护栏 + 热重载按钮 + 模板统一                  | `d5cd79b` |
| 体验类：刷新提示 / 紫外线 / 右键菜单 / aria-label                  | `4b6d377` |

每个提交都跑过 `cargo test`（66）、`npm test`（102）、`npx tsc --noEmit`、
`cargo clippy --all-targets`（零警告）。

### 0.2 实机验证过的（release 构建 + CDP，页面 `http://tauri.localhost/`）

- **P1-b**：可见时 `powershell.exe` 8 秒内 4 次；`window_close` 隐藏后 8 秒 **0 次**；
  单实例唤起后恢复 4 次。3 个并发 `media_get_current_session` 只拉起 1 个
  powershell（在途保护生效）。
- **P1-a**：启动后 `niutrans.json` 只剩 `appId/charCount`；`cmdkey /list` 能看到
  `niutrans.com.infoboard.tauri` 与 `qweather.com.infoboard.tauri`；
  localStorage 已无任何 key/token/secret 字段（含遗留的 `minimaxApiKey`）；
  天气占位符注入返回 `code=200`；翻译 `hello world → 你好世界`；
  没有 `secret_get` 命令；`app.log` 中 `key=` 命中 0 行。
- **P1-c**：保留的 `clipboard-manager:allow-write-text` 可用；已删除的
  `read_text` / `window.hide` / `window.set_focus` / `store.load` /
  `autostart.is_enabled` / `global-shortcut.*` 全部 "not allowed by ACL"。
- **CSP**：`https://i0.hdslb.com/...` 无违规；`https://example.com/favicon.ico`
  触发 `img-src` 违规；`http://localhost:5173/` 触发 `connect-src` 违规；
  `http://127.0.0.1:17831` 放行。
- **字体**：`document.fonts` 里 `Inter:100 900:loaded`（自托管生效，不再静默回退）。
- **插件护栏**：临时插件未声明命令时 invoke 被拒并提示"请在 tauriCommands 里声明"，
  声明后成功；点"重新加载插件"后插件代码确实重新执行。

### 0.3 仍未处理 / 需人工决定

1. **`app.log.1`（32 MB，含 479 行明文天气 Key）仍在原处**，用户选择自行处理：
   路径 `%APPDATA%\com.infoboard.tauri\app.log.1`，确认不需要后删除即可
   （当前 `app.log` 已确认无 Key）。
2. **i18n**：文案仍硬编码中文（工作量独立，未动）。
3. **外部插件沙箱**：`tauriCommands` 只是护栏（插件仍可直接用
   `window.__TAURI_INTERNALS__.invoke` 绕过）；真隔离需 iframe/Worker 沙箱。
4. **安装包**：`bundle.targets` 已改为 `["nsis"]`，但安装产物未做端到端安装验证。

### 0.4 开发期两个坑（本轮踩到，写在这里省时间）

1. **capability 只在 release 里才验得出来**：用 `tauri dev` / 直接跑 debug 二进制时，
   页面来自 `http://localhost:5173`（remote 源），本地 capability 不适用，
   **所有插件命令都会被 ACL 拒绝**（自有命令不受影响）。要验证 capability 就用
   release 构建，或 `cargo build --features custom-protocol` 的 debug 版。
2. **`cargo build --release` 不等于生产构建**：tauri 的 build.rs 用
   `dev = !custom-protocol` 判断，不带这个特性时 release 二进制**仍会去连 devUrl**。
   现在 `Cargo.toml` 已补 `[features] custom-protocol`，用法：
   `cargo build --release --features custom-protocol`（`tauri build` 会自动带上）。

## 1. 先看这里

**验证命令**（改完任何东西都先跑）：

```bash
cd src-tauri && cargo test      # 44 个，应全过
npm test                        # vitest，44 个
npx tsc --noEmit                # 无输出即通过
```

**本地起应用**：先 `npx vite --port 5173 --strictPort`，再 `src-tauri/target/debug/infoboard-tauri.exe`
（debug 版连 `localhost:5173`；`dist/` 是旧构建，**未用最新代码重新打包过**）。

**真实 WebView 里读状态**（端到端验证用）：启动应用前设置环境变量
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`，
然后用 CDP（`http://127.0.0.1:9222/json/list`）执行 JS。用完记得结束进程并清理脚本。

**数据目录**：`%APPDATA%\com.infoboard.tauri\`

- `app.log` 超过 5 MB 会轮转为 `app.log.1`。**`app.log.1` 可能是审计时遗留的 32 MB 旧日志，内含 479 行明文天气 API Key**，确认不需要后请手动删除。
- `plugins\` 是外部插件目录（里面现在有 `hello-world`、`system-info` 两个示例，可删）。

**仓库状态**：工作区里有 4 个**未跟踪**文件（`CODE_REVIEW.md`、`CODE_REVIEW.full.md`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`）和 `src-tauri/gen/schemas/*` 的构建自动改动，都不是我们的修改，没有提交。

## 2. 遗留问题（按优先级）

> 状态（2026-10-16）：P1-a、P1-b、P1-c、P1-d、P2 日志、P2 安全加固、P2 外部插件
> 已修复，下面的"解决办法"保留作为实现说明与复核依据；
> 未做的只有 i18n、外部插件沙箱（见"P2 其余审计条目"里的说明）。

### P1-a 凭据明文存储

| 位置                                                         | 现状                                                              |
| ------------------------------------------------------------ | ----------------------------------------------------------------- |
| `src-tauri/src/plugins/niutrans/mod.rs:41`                   | 小牛翻译 API Key 经 `tauri-plugin-store` 明文写入 `niutrans.json` |
| `src/plugins/settings/settingsStorage.ts` / `useSettings.ts` | 和风天气 Key 明文存 `localStorage['infoboard-settings']`          |
| 旧日志                                                       | 见第 1 节，`app.log.1` 里有历史泄漏                               |

**解决办法**

1. 存储：用 Windows 凭据管理器，Rust 侧用 `keyring` crate。版本注意：crates.io 上最新是 4.2.0，但它要求 rustc ≥ 1.88，而 `Cargo.toml` 声明 `rust-version = "1.77"`，`cargo add` 会自动退到 3.6.3。要么先修正 MSRV（见"其余审计条目"）再用 4.x，要么固定 `=3.6.3`。平台特性名（3.x 需要显式开启，如 `windows-native`）以 docs.rs 为准——我只查到了版本号，没有读 crate 文档。
2. 新增 `src-tauri/src/core/secrets.rs`：`set / get / has / delete(name)`，服务名固定 `com.infoboard.tauri`。凭据库不可用时返回明确错误，**不要回退到明文**。
3. 小牛翻译：`niutrans/mod.rs` 的 `read_field / write_field` 里 `apiKey` 改走 `secrets`，其余（appId、charCount）仍用 store。启动时做一次迁移：store 里有明文 `apiKey` → 写入凭据库 → 从 store 删除并 `save()`。
4. 天气 Key：前端不再持有。设置面板改调 `secret_set('qweather', …)` / `secret_has('qweather')`；`useWeather.ts`、`useLocationSearch.ts`（都直接读 `localStorage['infoboard-settings'].weatherApiKey`）的请求 URL 里用占位符，例如 `key={{QWEATHER_KEY}}`，由 `http_proxy_get` 在 Rust 里替换（只对 qweather 域名、只在发请求前替换，日志里只打印替换前的 URL）。迁移：前端启动时发现旧的 `weatherApiKey` → `secret_set` → 把该字段从 localStorage 清掉。
5. `settingsStorage.ts` 的 `sanitizeSettings` 去掉 `weatherApiKey` 字段，同步改 `src/__tests__/settingsStorage.test.ts`；设置面板输入框保存后清空并显示"已配置"（与小牛翻译现在的做法一致）。
6. 验收：保存后 `niutrans.json` 里没有 `apiKey`；DevTools 里 `localStorage` 没有 Key；凭据管理器里能看到对应条目；`grep key= app.log*` 无命中；天气和翻译功能仍可用。别忘了处理第 1 节提到的旧日志 `app.log.1`。

### P1-b 耗电：窗口隐藏到托盘后仍在后台跑

- `src/plugins/dynamic-island/useMediaControl.ts:130`：固定 **每 2 秒** `fetchSession()`，后端每次**新起一个 `powershell.exe`**（无在途保护、无缓存、无可见性判断）。
- `src/plugins/dynamic-island/useMusicPlayerBridge.ts:148`：`requestAnimationFrame` 每帧 `setState` 更新歌词进度（约 60 fps 重渲染整棵灵动岛），隐藏后也不停。
- 其他轮询同样没有 `document.visibilityState` 判断（用量/本地播放器等）。

**实测发现（会改变做法）**：我在真实应用里通过 `window_close`（与托盘"隐藏"同一路径）把窗口隐藏后，`document.visibilityState` 仍是 `visible`、`document.hidden` 仍是 `false`，也没有 `visibilitychange` 事件；后端 SMTC 查询频率隐藏前后都是 8 秒 4 次（每 2 秒一次）。**所以不能用前端可见性 API 判断窗口是否在后台，必须由 Rust 主动通知前端。** 最小化没测准（测的时候窗口已处于隐藏状态），需要重测。

**解决办法**

1. Rust：在 `src-tauri/src/core/window.rs` 新增 `set_main_visible(window, visible)`：执行 `hide()` / `show()`，写入一个全局 `AtomicBool`，并 `emit("window:visibility", visible)`。把所有隐藏/显示入口统一走它：`window.rs` 的 `toggle_main_window`、`show_and_focus`、`window_close` 命令，以及 `tray.rs` 的 `CloseRequested` 分支（约 59 行）。`window_minimize` 同样置 false，还原时置 true。
2. Rust：新增命令 `window_is_active` 返回该 `AtomicBool`，供前端启动时取初值，并注册到 `lib.rs` 的 `generate_handler!`。
3. 前端：新增 `src/core/useWindowActive.ts`：启动时 `invoke('window_is_active')`，再 `listen('window:visibility')`，返回 `boolean`。
4. 前端：`useMediaControl.ts`（约 123–141 行）依赖 `active`：为 false 时不创建 `setInterval`，变回 true 时先立即 `fetchSession()` 一次再启动定时器。`useMusicPlayerBridge.ts` 同理，`active=false` 时清除 `setTimeout` 与 `requestAnimationFrame`。
5. 后端防堆积：`media_get_current_session`（`media_control/mod.rs` 约 257 行起）加一个 `AtomicBool` "在途"标志，已有查询在跑时直接返回上一次的缓存结果，不再新起 `powershell.exe`。
6. 删掉 `media_control/mod.rs:278` 的 `eprintln!("… 原始 PS 输出: {output}")`：输出里带缩略图 base64（约 700 KB），每次轮询都写 stderr。
7. 歌词进度（`useMusicPlayerBridge.ts:139-152`）：不要每帧 `setState` 整个状态。把 `position` 放进 `ref`，由 `LyricsView` 自己用 `requestAnimationFrame` 读取并只更新当前行；或至少降到 200–250 ms 一次。

**验收**：启动应用时设置 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`，用 CDP 执行 `window.__TAURI_INTERNALS__.invoke('window_close')` 隐藏窗口，同时统计应用 stdout 里 `原始 PS 输出` 的行数（做了第 6 步后该日志没了，改为临时加一个计数日志，或用 `Get-Process powershell` 观察）。隐藏后 8 秒内应为 0，显示后恢复到约 4 次。另补 `useWindowActive` 的 vitest（mock `invoke` / `listen`，断言事件到来后返回值翻转）。

### P1-c 权限过宽（`src-tauri/capabilities/default.json`）

`store:default`、`autostart:default`、`global-shortcut:default`、`clipboard-manager:allow-read-text` 前端代码里**没有**对应的 import。
注意：`tauri-plugin-store` 是 **Rust 侧在用**（niutrans），收紧前端 capability 不会影响 Rust 调用，但要逐个确认；autostart 走 `core/autostart-bridge.ts`，需确认它调用的是哪条命令再改，误删会让功能静默失效。

**解决办法**（已核实的事实：前端没有 import `@tauri-apps/plugin-store` / `plugin-global-shortcut`，没有调用 `readText`；开机自启走自有命令 `autostart_is_enabled / autostart_set_enabled`；剪贴板只用到 `writeText`；`build.rs` 是裸的 `tauri_build::build()`）

1. 一次只删一项，删完立刻验证对应功能，再删下一项。建议顺序与验证：
   - 删 `clipboard-manager:allow-read-text`：截图"复制到剪贴板"仍可用。
   - 删 `global-shortcut:default`：`Ctrl+Shift+I` 仍能显隐窗口（快捷键由 Rust 在 `lib.rs` 注册，不经前端）。
   - 删 `autostart:default`：设置里"开机自启动"开关仍可读写。
   - 删 `store:default`：小牛翻译保存/读取 Key 仍正常（Rust 侧调用，预期不受影响）。
   - `window-state:default`：前端也没 import，同样先删再测"窗口大小位置能记住"。
   - `core:window:allow-close / hide / show / set-focus`：先 grep 前端有没有直接调用 `getCurrentWindow().hide()` 等，没有再删。
2. capability 缺失是**运行时静默失败**，编译期不会报错，所以每删一项都要启动应用手动点一遍，不能只跑 `cargo test`。
3. 注意：`build.rs` 没有声明 `AppManifest`（`tauri_build::Attributes::app_manifest` / `AppManifest::commands`），tauri-utils 里的 ACL 逻辑用 `has_app_manifest` 判断是否对自有命令启用 ACL，所以**推断**当前自有 `#[tauri::command]` 不受 capability 约束（我读了源码里的判断函数，没有实测）。结论：收紧 capability 只影响官方插件命令，限制不了外部插件调用自有命令，见下文"外部插件的限制"。若要让 capability 也管住自有命令，需要在 `build.rs` 里用 `AppManifest::new().commands(&[...])` 列出命令，并在 capability 里逐个授权，工作量不小，需单独评估。

### P1-d `http_proxy` 仍硬编码本机代理端口（C2 没修干净）

`src-tauri/src/core/http_proxy.rs:21` 的 `LOCAL_PROXY_CANDIDATES`（7897/7890/10809/1080）。
这里是"直连失败后**再**尝试"，不像 niutrans 那份是"无条件第一个"，所以影响小得多，但仍会：没跑代理时多几次必败连接，端口被别的服务占用时请求被转发给未知进程。
已在 niutrans 里改为"只用环境变量代理，否则直连"（`pick_proxy`），可照此处理，并改用同一个纯函数。

**解决办法**

1. 删除 `LOCAL_PROXY_CANDIDATES` 常量，以及 `http_proxy_get` 里追加它的循环（约 120–126 行）。
2. 把"尝试顺序"抽成纯函数，如 `build_attempts(env_proxy: Option<String>) -> Vec<Option<String>>`：有环境变量代理 → `[Some(env), None]`，否则只有 `[None]`（直连）。niutrans 的 `pick_proxy` 与 `http_proxy.rs` 的 `env_proxy()` 是两份重复逻辑，一并合并到一处（例如 `core/net.rs`）。
3. 如果确实想保留"自动用本机 Clash"的便利，做成设置项：让用户在设置里显式填代理地址，作为第三个候选，而不是写死端口。
4. 测试：无环境变量时 `build_attempts` 只含直连；有环境变量时它排第一。断言**行为**，不要用 `include_str!` 匹配源码字符串——我试过，测试代码自己会命中自己。

### P2 日志相关

- **B6 重复写盘**：Rust `app_log::emit` 已直接 `append_file`，前端 `appLog.ts:96` 对 `source === 'rust'` 又调用 `log_append_file` 写一次，且前缀变成 `[web] [web]`。
- **`log_append_file` 无校验**（`app_log.rs:102`）：level 无白名单、message 不过滤换行，可伪造日志行。
- 日志时间戳是裸 Unix 秒（`chrono_like_now`），注释理由不成立；`chrono` 依赖已确认**零使用**，可从 `Cargo.toml` 删除。

**解决办法**

- B6：把 `src/core/appLog.ts:96` 的条件 `level === 'error' || level === 'warn' || source === 'rust'` 里的 `|| source === 'rust'` 去掉（Rust 的 `emit` 已经直接写盘）。测试：mock `@tauri-apps/api/event` 的 `listen` 捕获回调，触发一条 rust 日志，断言 `invoke('log_append_file')` 没被调用；web 的 warn / error 仍会调用。
- `log_append_file` 校验（`app_log.rs:102`）：level 只接受 `error|warn|info|debug|log`，否则当作 `info`；message 里的 `\r`、`\n` 替换成空格（或转义），并限制长度（如 8 KB，超出截断，可复用 `core::text::truncate_bytes`）。写 Rust 单测：带换行的 message 只产生一行；非法 level 被归一。
- 时间戳：二选一。要可读日志就用已在 `Cargo.toml` 里的 `chrono`（`chrono::Local::now().format("%Y-%m-%d %H:%M:%S")`），这样 `chrono` 就不再是"零使用"；要保持精简就删掉 `chrono` 并手写格式化。别两头都不做。

### P2 安全加固（`src-tauri/tauri.conf.json`）

- CSP `script-src` 含 `'unsafe-eval'`。**现在它是有用的**：外部插件运行时用 `new Function` 执行转译后的代码（`src/core/pluginRuntime.ts`）。要去掉就得换执行方式，别直接删。
- `img-src` 含 `http: https:`，过宽。
- `connect-src` 里 `localhost:5173` 等 dev 源残留在生产 CSP（共 5 处）。
- `asset:` 未接线。Google Fonts 被 CSP 拦（字体静默回退）。
- `bundle.targets = "all"` 与 Windows 专属资源（RapidOCR）不匹配。

**解决办法**

- `img-src`：先确认远程图片到底用到哪些域名（已知 B 站头像字段 `ownerAvatar` 来自 `hdslb.com`，`bilibili-info/bridge.ts` 有该字段；我没逐个核对所有 `<img>`），再收紧为 `'self' data: blob: https://*.hdslb.com`，同时删掉 `asset: http://asset.localhost`（外部插件现在由 Rust 读源码，不走 asset 协议）。验证：灵动岛的 B 站封面/头像、截图预览仍能显示。
- dev 源：把 `http://localhost:5173`、`https://localhost:5173`、`ws://localhost:5173`、`wss://localhost:5173` 从 `app.security.csp` 挪到 `app.security.devCsp`（`tauri-utils` 的配置里有该字段，我只确认了字段存在，没实测效果）。验证：`cargo tauri dev` 仍能热更新，生产构建的 CSP 里不再出现 `localhost:5173`。
- Google Fonts：审计指出被 CSP 拦、字体静默回退。推荐把字体文件放进 `public/` 自托管并保持 `font-src 'self'`，不要放宽 CSP；先 `grep -rn "fonts.googleapis\|fonts.gstatic" index.html src` 找到引用。
- `unsafe-eval`：**现在不能删**，外部插件运行时靠 `new Function`。要去掉的前提是改成沙箱方案（见下一节）。
- `bundle.targets`：改成 `["nsis"]`（或 `["msi", "nsis"]`），因为 RapidOCR 是 Windows 专属资源。验证：`cargo tauri build` 只产出对应安装包。

### P2 外部插件的限制（有意为之，非 bug，但要知道）

- 插件必须**单文件**；只能 import `react`、`react/jsx-runtime`、`react-dom`、`@tauri-apps/api/core`（白名单见 `pluginRuntime.ts` 的 `SHARED_MODULES`）。`@tauri-apps/api/event` **已移除**（插件不应监听宿主事件，如 `screenshot:data`）。
- 插件代码跑在主窗口里，**权限等同于应用本身**。`manifest.tauriCommands` 已落地为**护栏**（声明之外一律拒绝，有 `pluginRuntime.test.ts` 的 fail-closed 用例）；但 `manifest.permissions` **仍无任何消费方**（保留字段），且这层护栏**不是安全边界** —— 插件仍可直接用 `window.__TAURI_INTERNALS__.invoke` 绕过。
- 热重载入口**已有**：设置面板「插件管理 → 重新加载插件」调用 `reloadPluginSystem()`（提交 `d5cd79b` 落地）。
- 插件导入/卸载**已有**：`.ibplugin` 插件包拖进设置面板即可安装，列表里可卸载（`plugins/pack.rs` 的 `install_plugin_package` / `uninstall_plugin` / `list_installed_plugins`，界面在 `SettingsPanel` 的插件管理区）。
- `_template`、`plugins/.plugin-template` 的 import 写法已统一成 `'@/core/types'`，并有 `?raw` 加载用例覆盖。
- 要更严的隔离需要 iframe/Worker 沙箱，工作量大，未做。

**遗留**

- `manifest.permissions` 要么删字段、要么实现校验，需要产品决策。
- 真隔离（沙箱）需单独立项：`<iframe sandbox>` + `postMessage`，或 Worker，由宿主代理命令调用。

### P2 其余审计条目（未逐条处理，细节见 `CODE_REVIEW.md` 第三节）

- **错误被吞**：`media_send_command` 失败归一为 `Ok(false)` 等。
- **死代码**：`screenshot::setup_screenshot`（空函数，编译告警）、`core/toast.rs` 整模块、`greet` 命令、`window_toggle_visibility` 事件、`src/plugins/settings/cities.ts`（517 行，无引用）、`getRelativeTime`、`editTodo`、`appStore.ts`、`PluginRegistry` 的若干方法。
- **性能/内存**：截图整屏 base64 在 Rust 静态量 + 前端 state 双份驻留；`bilibiliCache`、通知列表只增不减；`media_control` 每次轮询把 ~700 KB 输出写 stderr。
- **体验**：刷新按钮恒弹成功 toast；紫外线恒显示 `--`；右键菜单无边界钳制、无 Esc；纯图标按钮缺 `aria-label`；文案硬编码无 i18n；`useTodo` 截止日期不校验（`2026-02-30` 被改成 `2026-03-02`）；待办保存失败静默丢数据。
- **设置**：`useSettings.ts` 的 `setState` updater 内做写盘+派发事件（F2，StrictMode 下重复执行，约 68/74/89/94/112/117 行）；写失败静默吞掉。
- **ErrorBoundary**：全仓仍没有。设置读取已加校验（`sanitizeSettings`），但其他组件抛错仍会整窗白屏。
- **MSRV**：`Cargo.toml` 写 `rust-version = "1.77"` 但代码用了 1.80 特性（clippy 21 条）。

**解决办法（逐项）**

- 错误被吞：`media_send_command` 改为返回 `Result<bool, String>`，把 PowerShell 的错误带出去；前端 `sendCommand` 已有 `catch`，会显示出来。其余同类项逐个 grep `Ok(false)` / `.ok()` / `catch {}` 看是否合理。
- 死代码：每个先 `grep -rn` 确认无引用再删，删一个编译一次。顺序：`setup_screenshot`（还会消掉一条编译告警）→ `core/toast.rs` 与 `lib.rs` 里的 `pub mod toast;` → `greet` 命令及 `generate_handler!` 里的条目 → `window_toggle_visibility` 事件（`lib.rs:56`）→ `cities.ts`。`getRelativeTime`、`editTodo` 在 `src/plugins/todo/` 里仍有出现，**先确认是否有调用方**，别直接删。
- ErrorBoundary：新增一个 class 组件，`main.tsx` 的 `Root` 外包一层（fallback 显示错误、"重新加载"按钮、"打开日志台"）；再给 `PluginHost.tsx` 的 `PluginRenderer`（约 204 行）单独包一层，这样单个插件崩溃不影响其余。`getDerivedStateFromError` 的逻辑可抽成纯函数测试，渲染部分手动验证。
- F2（设置副作用在 updater 里）：把 `localStorage.setItem` 和 `dispatchEvent` 从 `setSettings(prev => …)` 里挪出来——用 `ref` 保存最新 settings，在事件处理函数中算出 `next`，先 `setSettings(next)`，再执行副作用；或用 `useEffect([settings])` 统一落盘。写失败时不要静默，至少 `console.error` 并提示用户。
- 待办：`useTodo` 的截止日期用 `new Date(y, m-1, d)` 往返比对（取回的年月日必须相同）来拒绝 `2026-02-30`；保存失败要提示而不是丢数据。这两项都容易写 vitest。
- 体验类（刷新按钮恒弹成功、紫外线 `--`、右键菜单越界/无 Esc、`aria-label`、i18n）：互相独立，按需单独处理，不建议合并成一个大改动。
- MSRV：`Cargo.toml` 的 `rust-version = "1.77"` 与代码实际需要不符。本机 `rustc` 是 1.96；改成真实最低版本（用 `cargo msrv`，或直接设为你要支持的版本），然后重跑 `cargo clippy`，那 21 条 MSRV 相关警告应随之消失。

## 3. 编译告警与小清理（6 条，都不影响功能）

**已全部处理**（`5849486`）：`unused import State`、`unused import serde::Deserialize`、
两处 `unnecessary unsafe`、`unused variable app`、`setup_screenshot` 全部清掉，
另外修了 3 条 clippy 告警并把 MSRV 改成真实值 1.80（`cargo clippy --all-targets` 现为零警告）。
`Cargo.toml` 里 `dirs` 已删；`chrono` 现在真的用上了（日志时间戳格式化）。

<details>
<summary>原始告警清单（保留备查）</summary>
```
unused import `State`              media_control/mod.rs:14
unused import `serde::Deserialize` niutrans/mod.rs:8
unnecessary `unsafe` block         media_control/mod.rs:202, ocr/mod.rs:134
unused variable `app`              media_control/mod.rs:260
function `setup_screenshot` never used   screenshot/mod.rs:24
```
另：`Cargo.toml` 里 `chrono`、`dirs` 零使用，`dirs` 可直接删；`chrono` 取决于"P2 日志相关"里时间戳的处理方式（用它格式化就保留，否则删）。

## 4. 没验证过的东西（别当成已确认）

- **最小化后从托盘/快捷键还原**：只有决策逻辑的单测（`core/window.rs`），没在真实窗口上点过。
- **F12 原生 DevTools**：命令名依据 tauri 2.11.6 源码改正（`plugin:webview|internal_toggle_devtools`），且该命令只在 debug 构建存在。2026-10-16 实测：release 下该命令**不存在**（"Command internal_toggle_devtools not found"，符合 tauri 的设计），所以打包版只能靠应用内日志台；debug 构建下的原生 DevTools 仍未实机按过。
- **release 打包**：2026-10-16 已能构建真正的生产二进制（`cargo build --release --features custom-protocol`），外部插件的 `new Function` 在 release 下**实测可用**（插件能加载并调用命令）。但安装包（`tauri build`）的端到端安装流程仍未验证。
- **OCR 并发修复**：用假引擎验证过（4 并发只启动 1 次），没用真实 RapidOCR 跑过。该测试需设置 `FAKE_OCR_EXE` 与 `FAKE_OCR_LOG`，**未设置时自动跳过**，所以默认的 `cargo test` 不会覆盖它。
- **天气切城市取消旧请求**：`http-client` 有单测，没在界面上切过城市。
- 审计报告第五节的 5 项（多显示器/透明窗、TLS、安装包端到端等）仍然未验证。
- **最小化时前端的可见性**：窗口 **hide** 时前端 `visibilityState` 不变是已实测的事实（见 P1-b，2026-10-16 再次确认）。耗电修复（Rust 通知前端）已实测有效（隐藏后 8 秒 0 次 PowerShell）。**最小化**路径的实测仍缺（`window_minimize` 现在会置活跃为 false，且托盘/快捷键还原会置回 true）；从"最小化"直接还原到前台那条路径只加了 `Focused(true)` 的安全网，未实机点过。

## 5. 已完成（供对照，不用再做）

删除功能：灵动岛邮箱通知、OpenCode/MiniMax 用量查询（前后端、依赖、CSP、文档）。随之消失的审计条目：A1、A6、B1、B2、B3、B4、C1、P0-2。

| 修复                                                      | 提交                            |
| --------------------------------------------------------- | ------------------------------- |
| 媒体 PowerShell 管道死锁（P0-3）                          | `02fc405`                       |
| 字节截断 panic（C4）                                      | `fb60a6a`                       |
| 最小化后无法还原（P0-4）                                  | `f043238`                       |
| API Key 进日志（A4）+ 重定向绕过白名单                    | `aed84aa`                       |
| 日志无限增长（B5）                                        | `02ffa5e`                       |
| 单实例（B7，实测进程数保持 1）                            | `25dd4ea`                       |
| 日志台不刷新（D1）                                        | `b49c690`                       |
| 设置脏数据白屏（F1）                                      | `b066234`                       |
| eventBus.emit 序列化抛错（D2）                            | `907406e`                       |
| 请求不可取消（D3）                                        | `d9b303b`                       |
| 插件注册中断整批 / 初始化不可恢复（D4）                   | `5e505d8`                       |
| niutrans 硬编码代理（C2，**仅 niutrans**）                | `a721be6`                       |
| B 站空标题匹配（C5）                                      | `d635c0d`                       |
| OCR 启动竞态（C3）                                        | `8253d1e`                       |
| F12 命令名                                                | `ef03867`                       |
| 外部插件无法加载（P0-1，端到端实测通过）                  | `20c2fb5`、`d7660ce`、`6abf2a2` |
| P1-a 凭据明文 → Windows 凭据管理器                        | `af898ea`                       |
| P1-b 托盘隐藏后停止轮询/逐帧重渲染                        | `2b57007`                       |
| P1-c capability 收紧（只留实际用到的权限）                | `62597bd`、`75798b6`            |
| P1-d http_proxy 硬编码代理端口（C2 收尾）                 | `ddc595f`                       |
| P2 日志（B6 + 入参校验 + 可读时间戳）                     | `d01e430`                       |
| P2 安全加固（CSP / 字体自托管 / bundle.targets）          | `62597bd`                       |
| P2 外部插件（tauriCommands 护栏 / 热重载 / 模板）         | `d5cd79b`                       |
| P2 错误被吞 / 死代码 / ErrorBoundary / F2 / 待办 / 体验类 | 见第 0.1 节                     |
| 第 3 节编译告警 + clippy + MSRV                           | `5849486`                       |

## 6. 关键文件速查

| 想改什么         | 看哪里                                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 外部插件加载     | Rust：`src-tauri/src/plugins/loader.rs`；前端：`src/core/PluginLoader.ts`、`src/core/pluginRuntime.ts`（`createPluginModules` 是命令白名单护栏） |
| 插件注册/宿主    | `src/core/PluginRegistry.ts`、`src/core/PluginHost.tsx`（`reloadPluginSystem` + `plugins:reloaded` 事件）                                        |
| 窗口显隐         | `src-tauri/src/core/window.rs`（`set_main_visible` 是唯一入口，会 emit `window:visibility`），托盘在 `tray.rs`，快捷键和单实例在 `lib.rs`        |
| 前端窗口活跃状态 | `src/core/windowActive.ts`（store）+ `src/core/useWindowActive.ts`（Hook）                                                                       |
| 凭据（API Key）  | Rust：`src-tauri/src/core/secrets.rs`（keyring，无 `secret_get`）；前端：`src/plugins/settings/secrets.ts`（含旧数据迁移）                       |
| 网络代理         | `src-tauri/src/core/net.rs`（代理选择）+ `core/http_proxy.rs`（白名单、重定向策略、Key 占位符注入、错误脱敏）                                    |
| 日志             | Rust：`core/app_log.rs`；前端：`src/core/appLog.ts`、`LogConsole.tsx`                                                                            |
| 设置             | `src/plugins/settings/`（`settingsStorage.ts` 是带校验的纯函数，`persistSettings` 负责落盘）                                                     |
| 错误兜底         | `src/core/ErrorBoundary.tsx`（应用级在 `main.tsx`，插件级在 `InfoSection`/`ToolExpandPanel`/`PluginHost`）                                       |
| 测试             | Rust 在各模块的 `#[cfg(test)]`；前端在 `src/__tests__/`                                                                                          |

## 7. 建议的下一步顺序

1. **安装包端到端**：`npx tauri build` 已能产出
   `target/release/bundle/nsis/InfoBoard_0.1.0_x64-setup.exe`（本轮已验证打包成功、
   打包后的 exe 实机通过全部 ACL/CSP/功能检查），但**安装流程与安装后首启未验证**。
2. **删掉旧日志** `%APPDATA%\com.infoboard.tauri\app.log.1`（32 MB，含明文 Key）。
3. **最小化路径实测**：`window_minimize` 已接入活跃状态，但"最小化→从系统还原"
   只加了 `Focused(true)` 安全网，未实机点过。
4. **i18n**：文案硬编码中文，需要独立立项。
5. **外部插件沙箱**：现在只是 `tauriCommands` 护栏，真隔离要 iframe/Worker。
6. 其余未验证项见第 4 节（OCR 真实引擎、天气切城市、多显示器/透明窗、TLS 等）。
