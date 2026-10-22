# DeepSeek 网页 HUD（外部插件）

点工具区图标 → 弹出一个常驻小窗，里面就是 **chat.deepseek.com** 本身。
登录一次就记住，关掉应用也不用重登。

## 为什么不是"面板里塞个 iframe"

两条都过不去：

1. **站点禁止被嵌**：`X-Frame-Options` / `frame-ancestors` 会把 iframe 打回白屏。
2. **面板太窄**：插件面板是主窗口的一部分，而主窗口是个窄长侧边栏
   （实测 399×1372），聊天区会被挤成一条缝。

所以窗口由**宿主**创建（`hud_open_deepseek`，见 `src-tauri/src/plugins/hud/`），
直接 `WebviewUrl::External("https://chat.deepseek.com/")` —— 等于一个只装了一个
站点的精简浏览器。外部插件建不了窗口，所以插件本身只负责"按一下"。

## 图标

工具区里用的是**具名 SVG 图标 `whale`**（鲸鱼，DeepSeek 的吉祥物），不是 emoji。

原因：工具区其它图标（`camera` / `settings` / `languages` / `cloud-download` /
`activity` / `download`）都是同一套几何 —— 24×24 网格、2px 描边、圆头圆角、
无填充、颜色跟随 `stroke`。emoji 🐋 是彩色字形，粗细和尺寸都不受控，
放在那排线性图标里会格外扎眼。

`whale` 定义在宿主的 `src/components/ToolSection.tsx` 的 `SVG_ICONS` 里，
来源是 `src/components/ToolSection.tsx`（和 `camera` / `settings` 那一排放在一起）：

```tsx
whale: (
  <>
    <path d="M2.2 13.75 C2.2 9 6.2 5.6 11 5.6 C14.3 5.6 16.9 7.6 18.4 10.7
             L22.2 6.9 L20.1 13 L22.4 19.2 L18 16.5 C16.6 19.2 14 20.6 10.9 20.6
             C6.1 20.6 2.2 17.5 2.2 13.75 Z" />
    <path d="M6.6 13.5 H6.62" />
  </>
)
```

一条闭合轮廓（身体 + 分叉尾鳍）+ 一个眼睛点，**没有填充**，所以 `ToolIcon`
传下来的 `stroke` 颜色（含 active 态）能直接生效。内容撑满 24 网格的
x 2.2–22.4 / y 5.6–20.6，和 `languages`、`camera` 的视觉体量对齐 ——
这一点是照着真机截图调的：第一版只占 75%×51%，在工具区里明显比邻居小一号。

> 这是**宿主注册表**里的图标：装到不含 `whale` 的旧版宿主上时，`ToolIcon`
> 会退回"把 icon 字符串当文字画"的分支，显示成灰色的 `whale` 字样。不影响功能。

## 行为

- 点图标 = 直接开窗，**不展开面板**（`ToolSection` 里按 id 特判，和网盘/B 站下载器一致）
- 已经开着 → 唤到前面，不重建（重建会丢当前页面状态）
- 位置：**由前端算**（`window.screenX/screenY/outerWidth/outerHeight`）传给
  `hud_open_deepseek` 的 `anchor`，Rust 只做纯数学，贴左侧放不下就放右侧 →
  这不只是"方便"：让 Rust 去查主窗口几何意味着从 worker 线程调
  `outer_position()` 之类的窗口查询，而上一版正是因此把主线程锁死（见下）
- 窗口有标题栏、可缩放、置顶、不占任务栏
- **磨砂玻璃透明窗**：底下的桌面能透进来（见下）

## 透明（磨砂玻璃）

窗口是 `transparent(true)`，加上 webview 画布透明（`background_color(alpha = 0)`，
Windows 上 alpha 非 0 会被忽略）。但光这样没用 —— **透明窗口只能露出「页面没画」
的地方**，而 DeepSeek 是 SPA，`body` / `#root` / 侧栏 / 气泡各画各的底。

所以建窗时还挂了一段 `initialization_script`（`HUD_GLASS_SCRIPT`），在远端页面
document-created 阶段就注入三层兜底：

1. 根元素铺半透明玻璃色 + `backdrop-filter: blur(18px)` —— 桌面透进来且是磨砂的
2. 清掉 `body` / `#root` 的底色，让第 1 层露出来
3. 扫「铺满视口且不透明」的容器逐个清底（只扫 `body > *` 与 `#root` 前两层，
   不遍历整棵树 —— 否则流式输出时每次 DOM 变更都要全量算样式，会卡）

`MutationObserver`（400ms 防抖）跟着 SPA 换页 / 换主题重挂。

**能调的地方**：透明度和模糊都在 `HUD_GLASS_SCRIPT` 里，两套配色各一行：

```js
dark  ? 'rgba(18, 18, 20, 0.55)' : 'rgba(250, 250, 252, 0.62)'   // 玻璃底色
backdrop-filter: blur(18px) saturate(1.15)                        // 磨砂强度
```

**做不到的两件事**（实测确认）：

- **标题栏仍是不透明的**：那是系统绘制的。改成 `decorations(false)` 就需要自绘
  拖拽区，而远端页面调不到 `invoke`，也就没法拖。所以保留系统标题栏。
- **文字配色仍是 DeepSeek 自己的**：深色主题（浅字）透到浅色桌面上对比度会降。
  想要更稳就调大 alpha，想要更透就调小 —— 两者是矛盾的，这里默认取了
  「浅色 0.62 / 深色 0.55」的折中值。

## 上一版为什么会把整个应用卡死

`app.log` 停在 `[HUD] 打开 DeepSeek` 之后再无输出。原因有两处叠加：

1. `restore_state` 会拿 `tauri-plugin-window-state` 的两把锁，并在持锁期间调
   `available_monitors()` / `set_size()` —— 这两个都要回调主线程；
2. 定位时在 worker 线程上查了主窗口的 `outer_position` / `outer_size` / `scale_factor`。

主线程因此被锁死，整个窗口失去响应。现在的写法**只保留仓库里验证过的路径**
（建窗走 async 命令 + `visible(false)` 再 `show()`，和内置截图覆盖窗同一套路），
并把三步都写进 `app.log`：`[HUD] ①开始建窗` → `②建窗完成 Xms` → `③已显示`。
另有 6 秒看门狗，超时会留一条 warn 直接说明卡在 `WebviewWindowBuilder::build()`。

## 安全边界

| 项 | 做法 |
| --- | --- |
| URL | 编译期常量，前端只能"按功能打开"，不能传任意地址 |
| 协议 | 只认 `https` |
| 权限 | 远端页面**不授予任何 Tauri 权限**（没配 `dangerousRemoteDomainIpcAccess`），它就是个普通网页，调不了 `invoke` |

这也是为什么 `deepseek-hud` 这个窗口**没有**写进 `capabilities/default.json` —— 它不需要任何 Tauri 能力。

## 依赖

宿主需含 `hud_open_deepseek` 命令（即本文档所在版本的 `src-tauri`）。
旧版宿主上插件仍会加载，但点图标会报"未知命令"；此时展开的面板里有兜底按钮，
点了也是同样的错 —— 重新构建应用即可。

## 想再加一个站点

1. `src-tauri/src/plugins/hud/mod.rs`：加一个 `HudSpec` 常量 + 一条 `hud_open_xxx` 命令
2. `src-tauri/src/lib.rs`：注册命令
3. `src/components/ToolSection.tsx`：按插件 id 特判，`invoke('hud_open_xxx')`
4. 复制这个插件目录，改 `id` / `name` / `icon` / `tauriCommands`
