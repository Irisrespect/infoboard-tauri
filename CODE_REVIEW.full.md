# InfoBoard 代码审查报告

- **仓库**：https://github.com/Irisrespect/infoboard-tauri （本地 `D:\infoboard-tauri-source`，master `c00df41`）
- **日期**：2026-10-16
- **方式**：**只读**（未改动、未提交任何文件）
- **取证手段**：
  1. 静态扫描（密钥 / unwrap / unsafe / 危险前端 API / TODO）+ `cargo clippy --all-targets` + `cargo test` + `tsc --noEmit`（含我临时移除 exclude 的扩展检查）
  2. **6 路并行逐行审计**：全部 87 个源文件（前端 12,031 行 TS/TSX、后端 4,237 行 Rust），每条带 `文件:行` + 代码原文
  3. **运行时取证**：启动真实构建产物一次，读取 `%APPDATA%\com.infoboard.tauri\app.log`（32 MB / 31.9 万行）
- **可信度标注**：`★` = 我本人已用 grep / 读码 / 实测**直接复核**（共 19 条）；未标 `★` 的条目来自逐行审计层，行号未逐条复核（抽样 15 条均属实）。

---

## 总览

| 等级 | 数量 | 含义 |
|---|---|---|
| 🔴 **阻断 P0** | **4** | 功能整体不可用 / 模块级失效 |
| 🟠 **严重 P1** | **26** | 功能失效、安全与隐私、稳定性、性能 |
| 🟡 **建议 P2** | **54** | 死代码、一致性、可维护性、体验细节 |
| ✅ 已验证通过 | 9 类 | 见第四节 |
| ⛔ 未验证 | 5 项 | 见第五节 |

> 计数为去重后的条目数（同一问题在审计中出现多次的已合并）。

---

## 一、🔴 阻断（4 条）

### P0-1 ★ 外部插件系统整条链断裂（4 个环，任一都致命）
| 环 | 位置 | 事实 |
|---|---|---|
| ① 扫描目录错 | `src-tauri/src/plugins/loader.rs:83` `PathBuf::from("plugins")` | 相对**进程 CWD**（注释却写"相对于可执行文件"）；dev 下 CWD=src-tauri 扫不到仓库根的 `plugins/`；装完的正式包 dist 里没有 `plugins/` 目录，扫描恒为空 |
| ② 返回相对路径 | `loader.rs:138` | 返回 `plugins\hello-world\index.tsx`（反斜杠相对路径），前端 `import()` 无法解析 |
| ③ 前端 import 断 | `src/core/PluginLoader.ts:58` `await import(meta.entryPath)` | 实测日志：`Failed to resolve module specifier 'plugins\hello-world\index.tsx'`（hello-world/system-info/模板 3 个全部失败） |
| ④ 无文件通道 + 源码不可执行 | `src-tauri/tauri.conf.json`（无 `assetProtocol`）、全仓 `convertFileSrc` 0 命中、`capabilities/default.json` 未开 asset | 即使路径修对，WebView 也读不到磁盘文件；且入口是 `.tsx` 源码（含 `@/core/types` 别名、JSX），运行时没有编译器 |

**影响**：README / QUICKSTART / TUTORIAL 教的"放个文件夹就能加插件"完全不可用。
**最小修复**：插件产物约定为预构建 ESM(.js) → 开 `assetProtocol` + CSP 放行 `http://asset.localhost` → `convertFileSrc()` 生成 URL 再 import → 扫描目录改用 `app.path().resource_dir()` 并把 `plugins/` 加进 `bundle.resources`。

### P0-2 ★ 邮件正文按字节截断会 panic，并让验证码检测**永久静默失效**
`src-tauri/src/plugins/mail/mod.rs:516`（同款 4 处：302 / 326 / 516 / 536，`CONTENT_MAX_LENGTH = 8192`）
```rust
let truncated = if text.len() > CONTENT_MAX_LENGTH { &text[..CONTENT_MAX_LENGTH] } else { &text };
```
- `text.len()` 是**字节数**，切片落在多字节中文字符中间 → `byte index is not a char boundary` panic。
- panic 发生在 `spawn_blocking` 闭包内、且 `checking_new` 标志（459 置位 / 481 复位）**复位语句执行不到** → 此后 `mail_check_new` 永远在 459 行提前返回空结果，**验证码功能直到重启前彻底失效**。
- **最小修复**：`text.chars().take(CONTENT_MAX_LENGTH).collect::<String>()` + 用 Drop guard 复位 `checking_new`。

### P0-3 ★ media_control 读取 PowerShell 输出的时机错误 → 管道死锁（媒体信息整体失效）
`src-tauri/src/plugins/media_control/mod.rs:204-228`
```rust
cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
loop {
    match child.try_wait() {
        Ok(Some(_status)) => {           // ← 只有进程已退出才开始读 stdout
            child.stdout.take()...read_to_string(&mut output)?;
```
- 子进程写满管道缓冲（约 4 KB）后阻塞在写、永不退出 → `try_wait` 一直 `None` → 12 s 超时 kill → 每次轮询都失败。
- 脚本允许最大 512 KB 缩略图（base64 后约 683 KB），**只要 SMTC 会话带缩略图就必然踩中**；`stderr` 全程无人读，同样会卡。
- **最小修复**：起独立线程持续 drain stdout/stderr，主线程只做超时控制；`stderr` 至少改 `Stdio::null()`。

### P0-4 窗口最小化后无法从托盘/快捷键恢复（应用"消失"）
`src-tauri/src/core/window.rs:6` 用 `minimize()`；恢复路径 `tray.rs:30`、`tray.rs:57`、`lib.rs:53` **只有 `show()`**（★已核对 window.rs 全文与三处调用点）。
- 窗口 `skipTaskbar=true` + `decorations=false`：最小化后任务栏无入口，`show()` 不还原最小化态，托盘切换也回不来 —— 只能托盘退出重启。
- **最小修复**：三个恢复点在 `show()` 前补 `window.unminimize()`；或把"最小化"按钮改为与关闭一致的 `hide()`。

---

## 二、🟠 严重（26 条）

### A. 凭据与隐私（6）
| # | 位置 | 问题 | 证据 |
|---|---|---|---|
| A1 ★ | `mail/mod.rs:70` | **IMAP 密码明文落盘** `%APPDATA%\com.infoboard.tauri\mail_config.json`（`MailConfig.pass` 无脱敏序列化；仅有给前端的 `MailConfigPublic`） | `fs::write(&self.config_path, json)` + types.rs:14 `pub pass: String` |
| A2 | `niutrans/mod.rs:41` | 小牛翻译 API Key 明文写入 `tauri-plugin-store`（`niutrans.json`，不加密） | `store.set(key, ...); store.save()` |
| A3 ★ | 前端 `useSettings.ts:19/21` | 和风天气 Key、MiniMax Key 明文存 `localStorage['infoboard-settings']` | 字段确在 Settings 快照中被整体 stringify |
| A4 ★ | `core/http_proxy.rs:149` + 前端 `useWeather.ts:447` | **API Key 随 reqwest 错误 URL 明文进 app.log**（无 `without_url`）；实测日志中 `key=` 出现 **515 次**、qweather 行 553 条；天气卡还会把含 Key 的错误串渲染到界面 | 全仓 `without_url` 命中 0 |
| A5 | `capabilities/default.json:13` | 权限过宽：`store:default`（可解析任意绝对路径 JSON，含 A2 的密钥文件）、`autostart:default`、`global-shortcut:default`、`clipboard-manager:allow-read-text` 前端均未直接使用 | 前端无 `@tauri-apps/plugin-store` 等 import |
| A6 | `mail/mod.rs:105` | `config.secure` 被忽略：无论配置真假一律强制隐式 TLS，143/STARTTLS 账户必然失败且提示误导 | 结构体有此字段、前端有开关，Rust 侧零引用 |

### B. 稳定性 / 卡死（7）
| # | 位置 | 问题 |
|---|---|---|
| B1 ★ | `mail/mod.rs:694`、`703` | **持全局 Mutex 做网络 I/O**（建连+TLS+login+fetch 全程持锁）；配合 B2 一次挂起 = 邮件模块整体锁死（前端 5 s/30 s 轮询会持续撞锁） |
| B2 | `mail/mod.rs:103` | 只设了 TCP 建连超时，**TLS 握手与 IMAP 读写无超时**，服务器假死即永久阻塞 |
| B3 ★ | `opencode/mod.rs:324` | `opencode_refresh_cookie` 是**非 async 命令**（默认跑主线程），内部 12 s + 3 s + 10 s 阻塞轮询 → 刷新时 UI 冻结最长约 25 s |
| B4 | `opencode/mod.rs:387` | TCP 触发失败时 `?` 直接返回，**不回收刚启动的 headless Chrome**（进程泄漏 + 占住真实 User Data 目录） |
| B5 ★ | `app_log.rs:38` | 日志**只追加、无轮转无上限**（实测 32 MB / 319,401 行），前端每条 warn/error 都落盘 |
| B6 | `app_log.rs:45-51` | 同一条后端日志**写盘两次**（Rust 直写 + 前端回写），前缀还出现 `[web] [web]` |
| B7 ★ | `Cargo.toml` | **缺少单实例插件**（`single-instance` 命中 0）：开机自启 + 手动双击可双开，两个托盘图标、并发写同一批 JSON/日志 |

### C. 功能正确性（5）
| # | 位置 | 问题 |
|---|---|---|
| C1 ★ | `mail/mod.rs:493` | `known_uid_next` 是死字段（只写不读）：新邮件检测退化为"最近 5 封未读"，**每 5 秒重复返回同一批邮件、重复把同一验证码写进剪贴板并弹提示** |
| C2 ★ | `niutrans/mod.rs:117-118` | **硬编码本地代理** `127.0.0.1:7897/7890` 作为候选且不探测端口：没跑 Clash 的机器上翻译请求必然 `Connection refused`，功能整体不可用（端口被别的服务占用时请求还会被转发给未知进程） |
| C3 | `ocr/mod.rs:84` | `ensure_started` 检查-再启动 **TOCTOU 竞态**：并发请求会重复拉起引擎并互相残杀（含孤儿进程） |
| C4 ★ | `ocr/mod.rs:290`、`bilibili_info/mod.rs:190` | 另一批**字节截断 panic**（`&line[..200]` / `&text[..min(200)]`）落在错误处理路径：中文错误页/风控页一出现就把"可软失败"升级为线程崩溃 |
| C5 | `bilibili_info/mod.rs:123` | 空标题参与匹配（`target.contains("")` 恒真）→ 选中无 bvid 的坏条目，整体补充失败 |

### D. 前端（4）
| # | 位置 | 问题 |
|---|---|---|
| D1 ★ | `core/appLog.ts:26/90` + `core/LogConsole.tsx:25` | 日志台快照引用恒定（模块级数组原地 push/splice），`useSyncExternalStore` **永不触发重渲染** → 打包后唯一排障入口看不到新日志 |
| D2 ★ | `core/eventBus.ts:178` | `emit` 在派发**之前**无条件 `JSON.stringify(payload)`：循环引用/BigInt 直接抛错，**该事件所有订阅者都收不到** |
| D3 | `core/http-client.ts:26` | Tauri 分支**忽略 AbortSignal**（取消是空操作）且把错误抹平成字符串 → 天气切城市时旧响应覆盖新城市数据并写入缓存；`AbortError` 判断永假 |
| D4 | `core/PluginHost.tsx:44` + `PluginRegistry.ts:39` | `initPromise` 永久缓存（含 rejected，失败后不可恢复且调用方无 catch）；`registerAll` 一个插件抛错即**中断整批注册**，半加载被当成功缓存 |

### E. 性能 / 耗电（2，均为"窗口隐藏后照跑"）
| # | 位置 | 问题 |
|---|---|---|
| E1 | `dynamic-island/useMediaControl.ts:130` | 每 **2 秒**轮询 SMTC，后端每次**新起一个 powershell.exe**（无在途保护、无缓存）；关窗只是 hide 到托盘，后台长期每 2 s 起一个进程 |
| E2 | `dynamic-island/useMusicPlayerBridge.ts:145` | 歌词进度用 `requestAnimationFrame` **每帧 setState**（约 60 fps 重渲染整棵灵动岛），隐藏到托盘也不停 |

### F. 设置与持久化（2）
| # | 位置 | 问题 |
|---|---|---|
| F1 | `settings/useSettings.ts:35` | 设置读取**零类型校验**：`disabledPlugins` 为 null/字符串即抛错，全仓无 ErrorBoundary → 打开设置面板整窗白屏不可自愈 |
| F2 | `settings/useSettings.ts:103` | 写盘与事件派发放在 `setState` updater 内（React 反模式），StrictMode 双跑会重复写盘+重复派发；写失败静默吞掉 |

---

## 三、🟡 建议（54 条，按主题）

| 主题 | 条目 |
|---|---|
| **错误被吞** | `mail` 账户级失败只写日志、命令仍返回成功（前端把"全部账户失败"显示成"没有新邮件"）；`mail read_config` 把损坏配置当"未配置"；`opencode read_cookie` 一律报"cookie 文件不存在"；`media_send_command` 把失败归一为 `Ok(false)`（4） |
| **死代码** | `screenshot::setup_screenshot` 空函数、`mail` 整组 `impl MailManager` I/O 半区（约 95-355 行，与 inner 版**双份分叉**）、`toast.rs` 整模块、`greet` 命令、`window_toggle_visibility` 事件、`cities.ts` 517 行静态数据 ★、`getRelativeTime`、`editTodo`、`niutrans getConfig`、`appStore.ts`、`PluginRegistry` 7 个方法、`PluginHost` 死组件 + `renderPlugin`（12） |
| **契约/一致性** | `permissions`/`tauriCommands` 声明无任何消费方（权限模型形同虚设）；`_template` 与真实插件三处契约不一致（展开结构、updater 副作用、被 tsc 排除）；日志时间戳是裸 Unix 秒且注释理由不成立；`tsconfig.json` exclude 掉 4 个目录造成检查盲区（实测无掩盖现有错误）；前端 `plugin:core\|internal_toggle_devtools` **命令名错误**（应为 `plugin:webview\|…`，F12 原生 DevTools 从未生效）★（5） |
| **安全加固** | `http_proxy` 白名单只校验首跳，reqwest 默认跟随 10 跳重定向（**可绕过白名单打内网**）；CSP `script-src 'unsafe-eval'`（产物内 eval 命中 0，可删）、`img-src http: https:` 过宽、dev 源 `localhost:5173` 残留在生产 CSP、`asset:` 未接线；`log_append_file` 无 level 白名单/换行过滤（可伪造日志行）；Google Fonts 被 CSP 拦（字体静默回退）；`bundle.targets="all"` 与 Windows 专属资源不匹配（8） |
| **性能/内存** | 每 2-30 s 的轮询多处无 `visibilityState` 判断（媒体/IMAP/用量/本地播放器）；截图整屏 base64 在 Rust 静态量 + 前端 state **双份驻留**且重复解码、主线程同步 PNG 编码；`bilibiliCache` 只增不减；通知列表只增不减；`media_control` 每次轮询把 ~700 KB 原始输出写 stderr（与上一行注释自相矛盾）；`useLocationSearch` 防抖 timer 无卸载清理（6） |
| **体验/UI** | 刷新按钮恒弹成功 toast（refresh 不返回 Promise）；紫外线恒显示 `--`；右键菜单无边界钳制、无 Esc；整卡 onClick 吞内部交互点击；角标定位依赖 `backdrop-filter` 隐式 containing block（无 badge 插件时不显）；`ToolExpandPanel` 的 `[data-plugin-id]` 选择器与信息区卡片撞车；指针移出窗口松手卡在 selecting、多屏选区不符；纯图标按钮缺 aria-label；文案硬编码无 i18n（9） |
| **小项** | `ToolSection` 硬编码 screenshot 特判（插件行为泄漏进内核）；`isEmoji` 用 length 判断（组合 emoji 判错）；`TitleBar` 最大化状态乐观翻转无同步；`useSettings` 密钥输入框 `type="text"`（MiniMax 是 password）；翻译配置两条命令写入非原子；邮箱表单只挡非空、`String(err)` 会显示 `[object Object]`；`useTodo` 截止日期不校验（`2026-02-30` 被静默改成 `2026-03-02`）；待办保存失败静默丢数据；`TodoCard` 模块级可变 `ACCENT` 主题色；待办 hover 驱动整列表重渲染（10） |

---

## 四、✅ 已验证通过

| 项 | 证据 |
|---|---|
| 无硬编码密钥（代码内） | 全仓 grep：0 命中；`weather/config.ts:16` 的 Key 是空串 |
| 前端无 XSS 面 | `dangerouslySetInnerHTML` / `eval(` / `new Function` 全仓 0 命中 |
| 命令注册表对齐 | `#[tauri::command]` 47 个 vs `generate_handler!` 47 个，逐一对齐（仅 `greet` 是模板遗留多余项） |
| Rust 测试 | `cargo test`：**30 passed / 0 failed** |
| 类型检查 | `tsc --noEmit` 通过（78 文件）；我临时移除 exclude 后 **82 文件仍 0 错误**（排除是盲区，不是掩盖） |
| `cargo clippy` | 42 条警告，**无 error**；其中 21 条是 MSRV 谎言（`rust-version = "1.77"` 但用了 1.80 特性）、3 条多余 unsafe、4 处死代码 |
| 无 TLS 旁路 | 全仓无 `danger_accept_invalid_certs` / `no_verify` |
| 无命令注入 | 唯一的 PowerShell 字符串插值来自固定 match 映射；opencode 的 taskkill 参数是 u32 |
| 部分并发正确性 | 未发现 Mutex 持锁跨 await、无死锁环路；React 列表 key 全部正确；主要 effect 监听器均有清理函数 |

---

## 五、⛔ 未验证

1. 除"外部插件加载失败"外的运行态交互未验证（未做 UI 操作、多显示器、透明窗渲染）
2. P0-3 管道死锁未用 Rust 实测复现（子代理用同机制 Python 复现，约 4 KB 缓冲）
3. P1-A6（secure 字段忽略）未抓包验证，仅静态确认零引用
4. TLS 证书校验行为未抓包
5. 修复后打包产物的端到端验收（安装版里插件/OCR/邮件实际可用性）

---

## 六、建议修复顺序（一句话复验路径）

1. **P0-2 邮件 panic + checking_new 复位** → `cargo test` + 构造含中文长正文邮件 → 日志不再有 `not a char boundary`
2. **P0-3 PowerShell 管道** → 播放带封面的媒体 → `media_get_current_session` 返回标题/缩略图而非超时
3. **P0-4 窗口恢复** → 点最小化 → 托盘单击 → 窗口回来
4. **P0-1 插件链路**（工作量大：asset 协议 + 预构建 JS + 目录基准）→ 放个 `.js` 插件目录 → 重启 → 卡片出现
5. **凭据 A1/A2/A3/A4**（keyring/DPAPI + URL 脱敏）
6. 其余按上文等级排序

---

*本报告由 6 路并行只读审计 + 主审复核生成；`★` 条目已逐条 grep/实测复核。未改动仓库任何文件。*
