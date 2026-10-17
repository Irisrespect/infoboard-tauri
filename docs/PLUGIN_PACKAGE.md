# `.ibplugin` 插件包 — 开发者文档

面向插件作者：如何编写一个插件、打包成单个 `.ibplugin` 文件、分发给别人安装。

> 只想**安装**别人给的插件？不用看这篇 —— 打开 **设置 → 插件管理**，
> 把 `.ibplugin` 拖进虚线框即可，装完自动加载，不需要重启。

**相关文档**

| 文档                                         | 内容                                               |
| -------------------------------------------- | -------------------------------------------------- |
| [PLUGIN_QUICKSTART.md](PLUGIN_QUICKSTART.md) | 5 分钟写出第一个插件                               |
| [PLUGIN_API.md](PLUGIN_API.md)               | 可用的 API 与命令清单                              |
| [PLUGIN_TUTORIAL.md](PLUGIN_TUTORIAL.md)     | 完整教程                                           |
| **本文**                                     | **包格式、命名与版本规则、打包与分发、校验与排错** |

---

## 1. `.ibplugin` 是什么

**它就是一个 zip 文件**，只是换了个扩展名。内容固定为「根目录两个文件」：

```
my-plugin-1.0.0.ibplugin   （zip）
├── manifest.json      # 必需，插件元数据
└── index.tsx          # 入口文件，文件名由 manifest.entry 指定
```

没有 `manifest.json`、或入口文件不存在，安装会被拒绝。

**为什么是单文件入口**：应用在运行时用 [sucrase](https://github.com/alangpierce/sucrase)
把 TS/TSX 转译成 CommonJS，再在一个受控的 `require` 环境里执行。
这个环境只提供了白名单里的几个模块，**不支持相对路径 import，也不支持 npm 包**。

---

## 2. manifest.json

最小可用的 `manifest.json`：

```json
{
  "id": "my-plugin",
  "name": "我的插件",
  "version": "1.0.0",
  "section": "info",
  "icon": "🎉",
  "entry": "index.tsx"
}
```

### 字段表

| 字段            | 必需 | 说明                                                                     |
| --------------- | ---- | ------------------------------------------------------------------------ |
| `id`            | ✅   | 插件唯一标识，**同时是安装目录名**。规则见下                             |
| `name`          | ✅   | 显示名称，非空                                                           |
| `version`       | ✅   | 版本号，建议语义化（`1.0.0`）                                            |
| `section`       | ✅   | 只能是 `"info"`（信息区卡片）或 `"tool"`（工具区图标）                   |
| `icon`          | ✅   | emoji 或内置 SVG 图标名（如 `camera`）。emoji 支持组合形式（`👋🏽`、`🇨🇳`） |
| `entry`         | ✅   | 入口文件，相对插件目录；不能是绝对路径或含 `..`                          |
| `author`        |      | 作者，显示在插件管理列表里                                               |
| `description`   |      | 描述                                                                     |
| `tauriCommands` |      | **要调用 `invoke` 就必须在这里声明命令名**，见第 4 节                    |
| `permissions`   |      | 保留字段，**当前无任何消费方**（声明了也不会校验）                       |

### `id` 的规则

必须匹配 `[A-Za-z0-9._-]`，长度 ≤ 64，不能以点开头/结尾，不能包含 `..`。

因为 `id` 会被直接用作插件目录名（`%APPDATA%\com.infoboard.tauri\plugins\<id>\`），
所以它同时受路径安全约束 —— 想写 `../evil` 这种会被明确拒绝。

**不要与内置插件重名**，否则注册时会被当作重复 id 跳过：

```
weather   todo   settings   dynamic-island   screenshot   translate
```

---

## 3. 入口文件的写法

```tsx
// import type 会在转译时被整体擦除，所以引用核心类型是安全的
import type { InfoBoardPlugin } from '@/core/types'
import { useState } from 'react'

function MyComponent() {
  const [count, setCount] = useState(0)
  return <button onClick={() => setCount((n) => n + 1)}>点击 {count} 次</button>
}

const MyPlugin: InfoBoardPlugin = {
  manifest: {
    id: 'my-plugin', // 必须与 manifest.json 的 id 一致
    name: '我的插件',
    version: '1.0.0',
    section: 'info',
    icon: '🎉',
  },
  Component: MyComponent,
  onInit: () => console.log('[MyPlugin] 已加载'), // 可选
  onDestroy: () => console.log('[MyPlugin] 已卸载'), // 可选，务必在这里清理定时器/监听
}

export default MyPlugin
```

要点：

- **默认导出**（`export default`）或具名导出 `plugin` 都行
- 导出的对象必须有 `manifest` 与 `Component`；`manifest.icon` 不能为空
- **顶层代码必须是纯的** —— 它会在加载瞬间执行。需要副作用请放进组件的 `useEffect`
  或 `onInit`。顶层 `await` / 副作用 import 会让加载失败
- `onDestroy` 里要清掉定时器和事件监听，卸载/重载插件时才会干净

### 可以 import 什么

白名单**只有 4 个**（与应用共用同一份实例，这一点对 React 很重要）：

| 模块                   | 用途                                |
| ---------------------- | ----------------------------------- |
| `react`                | `useState` / `useEffect` 等         |
| `react/jsx-runtime`    | JSX 自动运行时（你不必手写 import） |
| `react-dom`            | 渲染相关                            |
| `@tauri-apps/api/core` | `invoke`，且受 `tauriCommands` 约束 |

**不可用**（import 会在加载时报错，并列出可用模块）：

- ❌ **相对路径**（`./util`）—— 插件必须是单文件，请把代码合并进入口
- ❌ **其他 npm 包**（`lodash`、`axios` …）
- ❌ **`@tauri-apps/api/event`** —— 插件不应监听宿主事件（`screenshot:data` 里带整屏截图）；
  插件间通信用 `window` 的 `CustomEvent`
- ❌ **`@tauri-apps/plugin-*`** —— 包括 `plugin-store`、`plugin-clipboard-manager`
  （要持久化用 `localStorage`，要写剪贴板走宿主命令）

`import type` 不受白名单限制（会被擦除），所以可以放心 `import type { InfoBoardPlugin } from '@/core/types'`。

---

## 4. 调用 Rust 命令：`tauriCommands`

插件在 `manifest.json` 里**必须先声明**要调用的命令名，否则运行时会被拒绝（fail-closed）：

```json
{
  "id": "my-plugin",
  "tauriCommands": ["window_is_active", "ocr_is_ready"]
}
```

```tsx
import { invoke } from '@tauri-apps/api/core'

const active = await invoke<boolean>('window_is_active') // 已声明 → 放行
await invoke('window_close') // 未声明 → 抛错
```

未声明的报错形如：

```
插件未声明命令 "window_close"。请在 manifest.json 的 tauriCommands 里列出它
（当前已声明: window_is_active, ocr_is_ready）
```

没写 `tauriCommands`（或写了空数组）时，**所有 `invoke` 都会被拒绝**。

> ⚠️ **这只是护栏，不是安全边界。** 插件代码跑在主窗口里，权限等同于应用本身 ——
> 仍然可以直接用 `window.__TAURI_INTERNALS__.invoke` 绕过这层检查。
> 装本来就不信任的插件之前，请先读它的源码。

可用命令清单见 [PLUGIN_API.md](PLUGIN_API.md)。

---

## 5. 打包

仓库自带打包脚本（零依赖，只用 Node 内置 zlib）：

```bash
# 打一个插件
node scripts/pack-plugin.mjs plugins/hello-world

# 打一个目录下的所有插件
node scripts/pack-plugin.mjs plugins

# 指定输出目录
node scripts/pack-plugin.mjs plugins/hello-world -o build

# 看帮助
node scripts/pack-plugin.mjs --help
```

产出：`dist-plugins/<id>-<version>.ibplugin`

也可以挂到 npm script：`"pack:my-plugin": "node scripts/pack-plugin.mjs plugins/my-plugin"`。

### 打包时会做哪些校验

脚本会在本地就做完**与运行时一致**的校验，不合格直接报错，不用等装上去才发现：

| 检查                                   | 不合格时                           |
| -------------------------------------- | ---------------------------------- |
| `manifest.json` 存在且是合法 JSON      | 报错                               |
| `id` 规则（第 2 节）                   | 报错                               |
| `section` 是 `info` / `tool`           | 报错                               |
| `entry` 不是绝对路径、不含 `..`        | 报错                               |
| 入口文件存在                           | 报错                               |
| **入口的 import 都在白名单内**         | 报错，并列出可用模块               |
| 入口大小 ≤ 2 MB                        | 报错                               |
| 用了 `invoke` 但没声明 `tauriCommands` | **仅警告**（装上后 invoke 会被拒） |

后两条是应用侧的硬限制：入口超过 2 MB 会在 `read_external_plugin_source` 阶段被拒。

---

## 6. 安装、升级、卸载

### 安装（使用者视角）

**设置 → 插件管理**：

1. 把 `.ibplugin` **拖进虚线框**，或点框选文件
2. 自动安装并重新加载插件系统 —— **不需要重启应用**
3. 失败会直接弹出原因

### 安装时实际发生了什么

1. 校验包体积（≤ 16 MB）→ 读 `manifest.json` → 校验 `id`
2. 解压到临时目录 `.installing-<id>-<n>/`，逐条目做路径检查
   （拒绝 `..`、绝对路径、盘符 —— 防 zip slip），并限制条目数（≤ 64）
   与解压总量（≤ 8 MB）
3. 用**与扫描时同一套**校验解析 manifest、解析 `entry`
4. 原子改名到 `plugins/<id>/`；若该 id 已存在，先把旧目录挪走，
   改名失败会**回滚**回旧版本

任何一步失败都会清掉临时目录，**插件目录里不会留半成品**。

### 升级

**同 `id` 的包直接再拖一次即可** —— 等于覆盖安装。所以发布新版本时：

1. 改 `manifest.json` 的 `version`
2. 重新打包 → `<id>-<新版本>.ibplugin`
3. 让用户拖进去

### 卸载

**设置 → 插件管理** 的列表里点「卸载」。实际分三步（为了绕开 Windows 文件占用）：

1. 插件目录改名到 `.uninstalled-<id>-<pid>/`（此后不再被扫描到）
2. 重新加载插件系统（触发 `onDestroy`、卸载组件）
3. 删除文件；删不掉就留到下次启动自动清理

卸载的是**磁盘目录**，所以手动放进 `plugins/` 的插件同样能被卸载（列表里标注"手动放置"）。

---

## 7. 开发时的工作流（不打包）

改代码时不必每次都打包 —— 直接把插件目录放进运行时扫描的位置：

```powershell
$dst = "$env:APPDATA\com.infoboard.tauri\plugins\my-plugin"
New-Item -ItemType Directory -Force $dst | Out-Null
Copy-Item plugins\my-plugin\* $dst -Recurse -Force
```

然后 **设置 → 插件管理 → 重新加载插件**，改一次点一次即可看到效果。

打包只在**分发给别人**时才需要。

---

## 8. 排错

### 先看这里

按 **F12** 打开应用内日志台，搜索 `PluginLoader` —— 转译失败、import 了不支持的模块、
格式不合法等原因都会写明。导入 `.ibplugin` 失败时界面也会直接弹原因。

### 常见报错对照

| 现象 / 报错                                 | 原因与解决                                                                                |
| ------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `插件包根目录缺少 manifest.json`            | zip 里没有 `manifest.json`。注意别把插件目录本身也打进一层（包里应是根目录两个文件）      |
| `不是有效的插件包（zip）`                   | 文件损坏，或被改名/重新压缩过。重新用 `pack-plugin.mjs` 打包                              |
| `manifest.id 含非法字符` / `不能是路径片段` | `id` 只允许字母数字 `. _ -`，且不能含 `..`                                                |
| `manifest.section 必须是 'info' 或 'tool'`  | 写错了 section                                                                            |
| `入口文件不存在`                            | `manifest.entry` 与实际文件名对不上                                                       |
| `插件包含非法路径`                          | 包里有 `..` / 绝对路径条目。多半是用工具打包时把父目录也塞进去了                          |
| `插件包过大` / `解压后过大` / `条目过多`    | 超限：包 ≤ 16 MB、解压 ≤ 8 MB、条目 ≤ 64                                                  |
| 插件 import 了不支持的模块                  | 用了相对路径或 npm 包 —— 必须单文件、只用 4 个白名单模块                                  |
| `插件未声明命令 "xxx"`                      | 在 `manifest.json` 的 `tauriCommands` 里加上                                              |
| 插件不显示、但没报错                        | ①`id` 与内置插件重名 → 改名 ②设置里被禁用了 → 打开开关 ③`section` 不对 → 不在你期望的区域 |
| 装好后要重启才生效                          | 不需要 —— 装完会自动重新加载。若确实没刷新，点一下「重新加载插件」                        |

### 手动检查一个包

`.ibplugin` 就是 zip，可直接用任何解压工具打开（或改名为 `.zip`）确认结构：

```
manifest.json
index.tsx
```

---

## 9. 约定与最佳实践

- **`id` 用全小写 + 连字符**：`my-plugin`，避免大小写在不同文件系统上出问题
- **容器样式跟随主题**：用应用提供的 CSS 变量
  （`var(--bg-surface)`、`var(--text-primary)`、`var(--accent)` 等），
  别写死颜色，否则换主题时插件会显得格格不入
- **React 必须是同一份实例**：不要试图引入自己的 React —— 白名单已经保证共用同一份，
  hooks 才能正常工作
- **`onDestroy` 一定要清理**：定时器、`window` 事件监听、进行中的请求。
  卸载和"重新加载插件"都会调用它
- **顶层不要做副作用**：加载瞬间执行，抛错会导致插件整体加载失败
- **持久化用 `localStorage`，键名加插件前缀**：如 `my-plugin:settings`，避免与其他插件冲突
- **不要依赖 `manifest.permissions`**：该字段目前没有任何消费方

---

## 10. 格式契约（给维护者）

`dist-plugins/` 下的示例包是**被测试引用的 fixture**，不要随手删：

- 前端 `src/__tests__/packPlugin.test.ts` 解析它，并断言「重新打包示例得到的内容与它一致」
- Rust `plugins::pack::tests::installs_real_package_produced_by_pack_script`
  用 `include_bytes!` 读**同一个文件**并真的安装一遍，断言解出的入口内容正确

也就是说，打包脚本写出的 zip 与应用读取的 zip 被**双向锁死** ——
任何一方改坏格式，两个测试会同时失败。

改了示例插件源码后需要重新生成：

```bash
node scripts/pack-plugin.mjs plugins
```

（打包脚本对相同输入产出**逐字节一致**的输出，所以重新生成不会带来无谓 diff。）
