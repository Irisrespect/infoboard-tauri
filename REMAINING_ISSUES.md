# InfoBoard 代码审查 - 待修复问题清单

> 本文档列出代码审查后**仍需修复**的问题及简要解决方案。
> 
> 已删除的模块（mail、opencode、weather）相关问题已排除。

---

## 🔴 P0 阻断问题（2条）

### P0-1: 外部插件系统整条链断裂

**问题描述：**
1. **扫描目录错误**：`src-tauri/src/plugins/loader.rs:83` 使用 `PathBuf::from("plugins")`，相对于进程 CWD，dev 下 CWD=src-tauri 扫不到仓库根的 `plugins/`，打包后 dist 里没有 `plugins/` 目录
2. **返回相对路径**：`loader.rs:138` 返回 `plugins\hello-world\index.tsx`（反斜杠相对路径），前端 `import()` 无法解析
3. **前端 import 断**：`src/core/PluginLoader.ts:58` 实测日志显示 `Failed to resolve module specifier`
4. **无文件通道**：无 `assetProtocol`、无 `convertFileSrc`、capability 未开 asset，WebView 读不到磁盘文件；入口是 `.tsx` 源码（含别名、JSX），运行时无编译器

**解决方案：**
- **方案 A（推荐）**：外部插件改为"构建时集成"而非运行时加载
  - 开发者把插件放到 `src/plugins/` 下
  - 构建脚本扫描并打包进产物
  - 前端用静态 import 或 code-splitting chunk
  
- **方案 B**：完整实现运行时加载（工程量大）
  1. 修改扫描路径为 `app.path().appDataDir().join("plugins")`
  2. 返回规范化的文件 URL：`convertFileSrc(absolutePath)`
  3. 配置 `assetProtocol`、开启 `core:asset` capability
  4. 插件打包为 `.js` 产物（不能是源码 `.tsx`）
  5. 提供插件开发工具链（构建、热重载）

### P0-4: 窗口最小化后无法从托盘/快捷键恢复

**问题：** `src-tauri/src/core/window.rs:6` 用 `minimize()`，恢复路径只有 `show()`，但 `skipTaskbar=true` + `decorations=false` 时 `show()` 不还原最小化态

**解决方案：**
```rust
// window.rs 改用 hide()
pub fn toggle_visibility(window: &WebviewWindow) -> Result<()> {
    if window.is_visible()? {
        window.hide()?;  // 改这里
    } else {
        window.show()?;
        window.set_focus()?;
    }
    Ok(())
}

// 恢复路径（tray.rs、lib.rs）改为
window.unminimize()?;  // 先还原最小化
window.show()?;
window.set_focus()?;
```

---

## 🟠 P1 严重问题（9条）

### A3: 和风天气 Key、MiniMax Key 明文存 localStorage

**问题：** `src/core/useSettings.ts:19/21` 直接 `localStorage['infoboard-settings']`

**解决方案：**
```typescript
// 敏感字段改用 Tauri 命令存储到凭据管理器
interface SensitiveSettings {
  qweatherKey: string
  minimaxKey: string
}

// 前端
async function saveSecretKey(name: string, value: string) {
  await invoke('settings_set_secret', { name, value })
}

// 后端
#[tauri::command]
fn settings_set_secret(name: &str, value: &str) -> Result<(), String> {
  crate::core::secrets::set(&format!("settings_{}", name), value)
}
```

### A4: API Key 随 reqwest 错误 URL 明文进 app.log

**问题：** `src-tauri/src/core/http_proxy.rs:149` 和 `src/plugins/weather/useWeatherData.ts:447` 无 `without_url()`，天气卡还会把含 Key 的错误串渲染到界面

**解决方案：**
```rust
// http_proxy.rs 所有 map_err 改为
.map_err(|e| format!("请求失败: {}", e.without_url()))?

// 前端增加敏感参数过滤
function sanitizeError(err: string): string {
  return err.replace(/([?&]key=)[^&\s]+/gi, '$1***')
}
```

### A5: capabilities 权限过宽

**问题：** `capabilities/default.json:13` 包含前端未使用的 `store:default`、`autostart:default`、`global-shortcut:default`、`clipboard-manager:allow-read-text`

**解决方案：**
```json
// 从 default.json 移除未使用的权限，只保留实际用到的：
{
  "permissions": [
    "core:default",
    "core:window:allow-show",
    "core:window:allow-hide",
    "core:event:allow-emit",
    "shell:allow-open",
    "http:default"  // 按白名单配置
  ]
}
```

### B5: 日志只追加、无轮转无上限

**问题：** `src-tauri/src/core/app_log.rs:38` 实测 32 MB / 319,401 行

**解决方案：**
```rust
// 方案 A：使用 tracing-appender 的 RollingFileAppender
use tracing_appender::rolling::{RollingFileAppender, Rotation};

RollingFileAppender::new(
    Rotation::DAILY,  // 或 Rotation::never() + 手动按大小切
    app_dir,
    "app.log"
)

// 方案 B：启动时检查并截断
if log_file.metadata()?.len() > 10 * 1024 * 1024 {  // 10 MB
    let lines = read_last_n_lines(&log_file, 5000)?;
    fs::write(&log_file, lines.join("\n"))?;
}
```

### B7: 缺少单实例插件

**问题：** 开机自启 + 手动双击可双开，两个托盘图标、并发写同一批 JSON/日志

**解决方案：**
```toml
# Cargo.toml
[dependencies]
tauri-plugin-single-instance = "2.0"

# lib.rs
use tauri_plugin_single_instance::init as single_instance;

tauri::Builder::default()
    .plugin(single_instance(|app, _args, _cwd| {
        // 已有实例，聚焦现有窗口
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }))
```

### C4: OCR 和 bilibili_info 字节截断 panic

**问题：** `src-tauri/src/plugins/ocr/mod.rs:290` 和 `bilibili_info/mod.rs:190` 的 `&line[..200]` / `&text[..min(200)]` 会在多字节字符中间切片

**解决方案：**
```rust
// 改为按字符截断
fn truncate_safe(s: &str, max_chars: usize) -> String {
    s.chars().take(max_chars).collect()
}

// 或用现有库
s.chars().take(200).collect::<String>()
```

### C5: B站空标题参与匹配

**问题：** `src-tauri/src/plugins/bilibili_info/mod.rs:123` 空标题导致 `target.contains("")` 恒真

**解决方案：**
```rust
// 123 行改为
let target = target.trim();
if target.is_empty() {
    return Err("搜索词为空".into());
}

// 或在 filter 时跳过空标题的条目
.filter(|item| {
    !item.title.trim().is_empty() &&
    item.title.to_lowercase().contains(&target)
})
```

### D4: initPromise 永久缓存且失败后不可恢复

**问题：** `src/core/PluginHost.tsx:44` + `PluginRegistry.ts:39`，`registerAll` 一个插件抛错即中断整批注册

**解决方案：**
```typescript
// PluginRegistry.ts
class PluginRegistry {
  private initState: 'pending' | 'done' | 'failed' = 'pending'
  
  async registerAll(): Promise<void> {
    if (this.initState === 'done') return
    this.initState = 'pending'
    
    try {
      // 改为并行注册 + 捕获单个失败
      await Promise.allSettled(
        plugins.map(p => this.register(p).catch(err => {
          console.error(`插件 ${p.id} 注册失败:`, err)
        }))
      )
      this.initState = 'done'
    } catch (err) {
      this.initState = 'failed'
      throw err
    }
  }
  
  // 提供重试入口
  reset() {
    this.initState = 'pending'
  }
}
```

### E2: 歌词进度用 RAF 每帧 setState

**问题：** `src/plugins/dynamic-island/useMusicPlayerBridge.ts:145` 约 60 fps 重渲染整棵灵动岛

**解决方案：**
```typescript
// 方案 A：降频到合理帧率
const LYRIC_UPDATE_FPS = 10  // 100ms 更新一次足够

let lastUpdate = 0
const tick = (now: number) => {
  if (now - lastUpdate < 1000 / LYRIC_UPDATE_FPS) {
    rafRef.current = requestAnimationFrame(tick)
    return
  }
  lastUpdate = now
  setProgress(computeProgress())
  rafRef.current = requestAnimationFrame(tick)
}

// 方案 B：progress 用 CSS 变量 + ref 更新，不走 setState
const progressRef = useRef<HTMLDivElement>(null)
const tick = () => {
  if (progressRef.current) {
    progressRef.current.style.setProperty('--progress', `${computeProgress()}%`)
  }
  rafRef.current = requestAnimationFrame(tick)
}
```

### F1: 设置读取零类型校验

**问题：** `src/core/settings/useSettings.ts:35`，`disabledPlugins` 为 null/字符串即抛错，全仓无 ErrorBoundary

**解决方案：**
```typescript
// 增加运行时类型守卫
function parseSettings(raw: unknown): Settings {
  const obj = typeof raw === 'object' && raw !== null ? raw : {}
  
  return {
    qweatherKey: getString(obj, 'qweatherKey', ''),
    qweatherLocation: getString(obj, 'qweatherLocation', '101010100'),
    disabledPlugins: getStringArray(obj, 'disabledPlugins', []),
    minimaxKey: getString(obj, 'minimaxKey', ''),
    // ...
  }
}

function getString(obj: any, key: string, fallback: string): string {
  const val = obj[key]
  return typeof val === 'string' ? val : fallback
}

function getStringArray(obj: any, key: string, fallback: string[]): string[] {
  const val = obj[key]
  return Array.isArray(val) && val.every(x => typeof x === 'string')
    ? val
    : fallback
}

// 最外层加 ErrorBoundary
<ErrorBoundary fallback={<SettingsError onReset={resetSettings} />}>
  <SettingsPanel />
</ErrorBoundary>
```

### F2: 写盘与事件派发在 setState updater 内

**问题：** `src/core/settings/useSettings.ts:103` React 反模式，StrictMode 双跑会重复写盘+重复派发

**解决方案：**
```typescript
// 改为 useEffect 监听变化
const [settings, setSettings] = useState(initialSettings)

// 写盘副作用移到 effect
useEffect(() => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
    eventBus.emit('settings:changed', settings, 'useSettings')
  } catch (err) {
    console.error('保存设置失败:', err)
    // 可选：通知用户
  }
}, [settings])

// 更新函数变为纯更新
const updateSettings = useCallback((partial: Partial<Settings>) => {
  setSettings(prev => ({ ...prev, ...partial }))
}, [])
```

---

## 🟡 P2 建议问题（54条）

### 错误被吞（4条）

1. **bilibili_info**：账户级失败只写日志，命令仍返回成功，前端把"全部失败"显示成"没有结果"
   - 解决：命令返回 `Result<T, String>`，前端 catch 并显示错误

2. **media_send_command**：失败归一为 `Ok(false)`，调用方无法区分"命令不支持"vs"执行失败"
   - 解决：返回 `Result<bool, String>` 或枚举 `CommandResult { Success, NotSupported, Failed(String) }`

3. **其他模块的错误静默**：多处 `.catch(() => {})` 或 `.unwrap_or_default()`
   - 解决：至少记录日志，关键路径要向上传播

### 死代码（12条）

建议批量删除：
- `src-tauri/src/core/toast.rs` 整模块
- `src/data/cities.ts` 517 行静态数据（如不用）
- `src/core/utils/getRelativeTime.ts`（如不用）
- `src/plugins/plugin-system/PluginHost.tsx` 死组件
- `src/plugins/plugin-system/PluginRegistry.tsx` 中未调用的 7 个方法

**工具辅助：**
```bash
# 用 cargo-udeps 找 Rust 死依赖
cargo +nightly udeps

# 用 ts-prune 找 TS 死导出
npx ts-prune
```

### 契约/一致性（5条）

1. **permissions/tauriCommands 无消费方**
   - 删除或实现运行时校验

2. **_template 与真实插件不一致**
   - 同步模板，或改用 CLI 脚手架生成

3. **前端 DevTools 命令名错误**：`plugin:core|internal_toggle_devtools` 应为 `plugin:webview|internal_toggle_devtools`
   - 解决：`src/components/TitleBar.tsx` 修正命令名

4. **tsconfig.json exclude 造成检查盲区**
   - 移除不必要的 exclude，让 tsc 检查所有代码

### 安全加固（8条）

1. **http_proxy 白名单可绕过**：reqwest 默认跟随 10 跳重定向
   ```rust
   let client = reqwest::Client::builder()
       .redirect(reqwest::redirect::Policy::none())  // 禁止重定向
       .build()?;
   ```

2. **CSP 过宽**
   ```json
   // tauri.conf.json
   "csp": {
     "default-src": "'self'",
     "script-src": "'self' 'wasm-unsafe-eval'",  // 移除 unsafe-eval
     "img-src": "'self' https://i0.hdslb.com https://api.qweather.com",  // 具体域名
     "connect-src": "'self' https://api.niutrans.com https://devapi.qweather.com",
     "style-src": "'self' 'unsafe-inline'",
     "font-src": "'self'"  // 自托管字体
   }
   ```

3. **log_append_file 无 level 白名单/换行过滤**
   ```rust
   const ALLOWED_LEVELS: &[&str] = &["error", "warn", "info", "debug"];
   if !ALLOWED_LEVELS.contains(&level) {
       return Err("无效日志级别".into());
   }
   let message = message.replace(&['\r', '\n'][..], " ");  // 防止伪造多行
   ```

4. **Google Fonts 被 CSP 拦**
   - 下载字体到 `src/assets/fonts/`，CSS 改用 `@font-face`

5. **bundle.targets="all"**
   - 改为 `"targets": ["nsis"]` 或 `["msi"]`（只构建 Windows 安装包）

### 性能/内存（6条）

1. **多处轮询无 visibilityState 判断**
   ```typescript
   const isVisible = useWindowActive()
   useEffect(() => {
     if (!isVisible) return  // 隐藏时不轮询
     const timer = setInterval(poll, 2000)
     return () => clearInterval(timer)
   }, [isVisible])
   ```

2. **截图 base64 双份驻留**
   - 方案 A：Rust 返回临时文件路径，前端用 `convertFileSrc` 读取，用完删除
   - 方案 B：流式传输，不在内存中完整保存

3. **bilibiliCache 只增不减**
   ```typescript
   if (cache.size > 100) {
     const oldest = [...cache.entries()]
       .sort((a, b) => a[1].expires - b[1].expires)[0]
     cache.delete(oldest[0])
   }
   ```

4. **通知列表只增不减**
   ```typescript
   const MAX_NOTIFICATIONS = 50
   if (notifications.length >= MAX_NOTIFICATIONS) {
     setNotifications(prev => prev.slice(-MAX_NOTIFICATIONS + 1))
   }
   ```

5. **useLocationSearch 防抖 timer 无清理**
   ```typescript
   useEffect(() => {
     return () => {
       if (debounceTimerRef.current) {
         clearTimeout(debounceTimerRef.current)
       }
     }
   }, [])
   ```

### 体验/UI（9条）

1. **刷新按钮恒弹成功 toast**
   - 解决：`refresh()` 返回 Promise，成功才弹 toast

2. **紫外线恒显示 `--`**
   - 检查数据源，显示真实值或"暂无数据"

3. **右键菜单无边界钳制、无 Esc**
   ```typescript
   // 钳制到视口内
   const rect = menuRef.current.getBoundingClientRect()
   if (rect.right > window.innerWidth) {
     menuRef.current.style.left = `${window.innerWidth - rect.width - 8}px`
   }
   
   // Esc 关闭
   useEffect(() => {
     const onKeyDown = (e: KeyboardEvent) => {
       if (e.key === 'Escape') onClose()
     }
     document.addEventListener('keydown', onKeyDown)
     return () => document.removeEventListener('keydown', onKeyDown)
   }, [onClose])
   ```

4. **整卡 onClick 吞内部交互点击**
   ```typescript
   // 内部按钮
   <button onClick={e => { e.stopPropagation(); doAction() }}>
   ```

5. **指针移出窗口松手卡在 selecting**
   ```typescript
   useEffect(() => {
     const onPointerUp = () => setSelecting(false)
     document.addEventListener('pointerup', onPointerUp)
     document.addEventListener('pointercancel', onPointerUp)
     return () => {
       document.removeEventListener('pointerup', onPointerUp)
       document.removeEventListener('pointercancel', onPointerUp)
     }
   }, [])
   ```

6. **纯图标按钮缺 aria-label**
   ```tsx
   <button aria-label="刷新天气">
     <RefreshIcon />
   </button>
   ```

7. **文案硬编码无 i18n**
   - 短期：提取常量到 `src/i18n/zh-CN.ts`
   - 长期：接入 i18next 或 react-intl

8. **其他小项**：详见报告"小项（10）"部分

---

## 修复优先级建议

### 第一批（阻断 + 高危）
1. P0-4 窗口恢复（影响所有用户）
2. P0-1 外部插件（如需此功能）
3. A3 敏感 Key 加密（安全）
4. A4 日志脱敏（安全）
5. B7 单实例（防数据损坏）

### 第二批（稳定性）
6. C4 字节截断 panic
7. B5 日志轮转
8. F1 设置类型校验
9. D4 插件注册容错

### 第三批（性能与体验）
10. E2 歌词帧率优化
11. 批量删除死代码
12. CSP 收紧
13. UI 细节改进

---

## 验证清单

修复后建议验证：
- [ ] 最小化后可从托盘恢复
- [ ] 双击启动时只有一个实例
- [ ] 日志文件大小可控
- [ ] 敏感 Key 不在 localStorage
- [ ] 错误日志不含完整 API Key
- [ ] 中文错误消息不会导致 panic
- [ ] 插件加载失败不影响其他插件
- [ ] 隐藏到托盘后轮询停止（htop/任务管理器验证）

---

*生成时间：2026-10-17*
*基于 CODE_REVIEW.md 和已修复提交整理*
