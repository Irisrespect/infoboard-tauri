# 外部插件示例：Hello World

这是一个最简单的外部插件，演示如何编写和加载外部插件。

## 目录结构

```
plugins/
└── hello-world/
    ├── manifest.json   # 插件元数据
    ├── index.tsx       # 插件入口
    └── README.md       # 说明文档
```

## manifest.json

```json
{
  "id": "hello-world",
  "name": "你好世界",
  "version": "1.0.0",
  "author": "InfoBoard Team",
  "description": "最简单的外部插件示例",
  "section": "info",
  "icon": "👋",
  "entry": "index.tsx"
}
```

### 字段说明

| 字段            | 必填 | 说明                                                       |
| --------------- | ---- | ---------------------------------------------------------- |
| `id`            | ✅   | 插件唯一标识，全局不可重复                                 |
| `name`          | ✅   | 插件显示名称                                               |
| `version`       | ✅   | 版本号，建议使用语义化版本                                 |
| `author`        | ❌   | 插件作者                                                   |
| `description`   | ❌   | 插件描述                                                   |
| `section`       | ✅   | 插件所属区域，`info` 或 `tool`                             |
| `icon`          | ✅   | 插件图标，支持 emoji 或图片路径                            |
| `entry`         | ✅   | 入口文件路径，相对于插件目录                               |
| `permissions`   | ❌   | 声明的权限列表（**当前无消费方**，保留字段）               |
| `tauriCommands` | ❌   | **要调用 `invoke` 就必须在这里声明命令名**，否则运行时被拒 |

## index.tsx

```tsx
import type { InfoBoardPlugin } from '@/core/types'

const HelloWorldPlugin: InfoBoardPlugin = {
  manifest: {
    id: 'hello-world',
    name: '你好世界',
    version: '1.0.0',
    author: 'InfoBoard Team',
    description: '最简单的外部插件示例',
    section: 'info',
    icon: '👋',
    entry: 'index.tsx',
  },

  Component: () => {
    return (
      <div className="hello-world-plugin">
        <h1>👋 Hello, World!</h1>
        <p>这是一个外部插件示例。</p>
        <p>你可以在这里添加任何 React 组件。</p>
      </div>
    )
  },

  onInit: () => {
    console.log('[HelloWorld] 插件初始化')
  },

  onDestroy: () => {
    console.log('[HelloWorld] 插件销毁')
  },
}

export default HelloWorldPlugin
```

## 开发指南

### 1. 创建插件目录

在 `plugins/` 下创建新目录，目录名建议与 `id` 一致：

```bash
mkdir plugins/your-plugin
cd plugins/your-plugin
```

### 2. 编写 manifest.json

必须包含所有必填字段，`id` 需要全局唯一。

### 3. 编写入口文件

入口文件必须导出一个符合 `InfoBoardPlugin` 接口的对象：

- `default` 导出：推荐方式
- `plugin` 具名导出：备选方式

### 4. 使用 TypeScript

建议使用 TypeScript 以获得类型提示和错误检查：

```tsx
import type { InfoBoardPlugin, PluginComponentProps } from '@/core/types'

const MyPlugin: InfoBoardPlugin = {
  manifest: {
    // ...
  },
  Component: (props: PluginComponentProps) => {
    // 可以使用 props.manifest 访问当前插件配置
    return <div>...</div>
  },
}

export default MyPlugin
```

### 5. 使用 Tauri API

外部插件可以调用所有 Tauri API：

```tsx
import { invoke } from '@tauri-apps/api/core'

const MyPlugin: InfoBoardPlugin = {
  manifest: {/* ... */},
  Component: () => {
    const handleClick = async () => {
      const result = await invoke('some_command')
      console.log(result)
    }

    return <button onClick={handleClick}>调用 Rust</button>
  },
}

export default MyPlugin
```

### 6. 访问其他插件

外部插件可以通过 `pluginRegistry` 访问其他已注册的插件：

```tsx
import { pluginRegistry } from '@/core/PluginRegistry'

// 在组件内
useEffect(() => {
  const weatherPlugin = pluginRegistry.get('weather')
  if (weatherPlugin) {
    console.log('天气插件已加载:', weatherPlugin.manifest.name)
  }
}, [])
```

## 热重载

**设置 → 插件管理 → 重新加载插件** 即可，不用重启应用。它会先
`pluginRegistry.clear()`（触发每个插件的 `onDestroy`）再重新扫描 `plugins/` 目录。

想在代码里触发同样的动作：

```tsx
import { reloadPluginSystem } from '@/core/PluginHost'

// 在开发面板或控制台执行
await reloadPluginSystem()
```

## 安装 / 卸载 / 分发

### 安装插件包（给使用者）

把 `.ibplugin` 文件**拖到 设置 → 插件管理 的虚线框**里，或点「选择插件包」，
安装后自动加载。不需要知道插件目录在哪，也不需要重启。

### 卸载

**设置 → 插件管理** 的插件列表里点「卸载」，会删除插件目录并重新加载。

### 打包分发（给作者）

```bash
node scripts/pack-plugin.mjs <插件目录>        # 例如 plugins/my-first-plugin
# 产出 dist-plugins/<id>-<version>.ibplugin
```

`.ibplugin` 就是一个 zip，根目录含 `manifest.json` 与入口文件。
使用者拖进去即可安装；同 id 的包会覆盖安装（等于升级）。

### 手动安装（开发时）

直接把插件目录放到 `%APPDATA%\com.infoboard.tauri\plugins\` 下，
再点「重新加载插件」。改完源码点一下就能看到效果。

## 常见问题

### 插件未被加载？

1. 检查插件是否放在 `%APPDATA%\com.infoboard.tauri\plugins\`（不是安装目录，也不是仓库里的 `plugins/`）
2. 检查 `manifest.json` 格式是否正确
3. 检查 `entry` 文件路径是否正确
4. 按 F12 打开应用内日志台，搜索 `PluginLoader`：转译失败、import 了不支持的模块等原因都会写在这里

导入 `.ibplugin` 失败时界面会直接弹出原因（包损坏 / 缺 manifest.json / id 不合法 / 包过大等）。

### 如何调试插件？

在插件代码中使用 `console.log`，日志会进应用内日志台（F12 打开）。

### 插件可以访问哪些 API？

外部插件运行在受控环境里，只能 import 下面这些模块（与应用共用同一份实例）：

- `react`、`react/jsx-runtime`、`react-dom`
- `@tauri-apps/api/core`（`invoke`）—— 且只能调用 manifest 的 `tauriCommands` 里声明过的命令

不支持：相对路径 import（插件必须是单文件）、其他 npm 包、`@/core/*` 运行时模块（如 `pluginRegistry`）、
以及 `@tauri-apps/api/event`（插件不应监听宿主事件）。`import type` 会被擦除，所以
`import type { InfoBoardPlugin } from '@/core/types'` 仍然可用。

### 如何分发插件？

用仓库自带脚本打包成**单个 `.ibplugin` 文件**，对方在 设置 → 插件管理 里拖进去即可安装
（见上面「打包分发」）：

```bash
node scripts/pack-plugin.mjs <插件目录>
```

也仍然可以直接把整个插件目录压成 ZIP，让对方解压到
`%APPDATA%\com.infoboard.tauri\plugins\` —— 但那样对方需要手动找目录，
`.ibplugin` 是更省事的方式。

## 下一步

- 查看更多插件示例：`docs/PLUGIN_EXAMPLES.md`
- 了解插件 API 文档：`docs/PLUGIN_API.md`
- 开发自定义 Tauri 命令：`docs/PLUGIN_RUST.md`
