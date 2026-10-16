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

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | ✅ | 插件唯一标识，全局不可重复 |
| `name` | ✅ | 插件显示名称 |
| `version` | ✅ | 版本号，建议使用语义化版本 |
| `author` | ❌ | 插件作者 |
| `description` | ❌ | 插件描述 |
| `section` | ✅ | 插件所属区域，`info` 或 `tool` |
| `icon` | ✅ | 插件图标，支持 emoji 或图片路径 |
| `entry` | ✅ | 入口文件路径，相对于插件目录 |
| `permissions` | ❌ | 声明的权限列表 (未来版本) |
| `tauriCommands` | ❌ | 自定义 Tauri 命令列表 (未来版本) |

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
  manifest: { /* ... */ },
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

开发时修改外部插件后，调用以下方法重新加载：

```tsx
import { reloadPluginSystem } from '@/core/PluginHost'

// 在开发面板或控制台执行
await reloadPluginSystem()
```

## 常见问题

### 插件未被加载？

1. 检查 `plugins/` 目录是否存在且位于可执行文件同级
2. 检查 `manifest.json` 格式是否正确
3. 检查 `entry` 文件路径是否正确
4. 查看控制台错误日志

### 如何调试插件？

在插件代码中使用 `console.log` 或浏览器开发者工具断点调试。

### 插件可以访问哪些 API？

外部插件可以访问：
- 所有 React API
- 所有 Tauri API
- InfoBoard 提供的核心 API (`pluginRegistry`, `initPluginSystem` 等)
- 其他已注册的插件

### 如何分发插件？

将整个插件目录（包含 `manifest.json` 和 `entry` 文件）打包为 ZIP，用户解压到 `plugins/` 目录即可使用。

## 下一步

- 查看更多插件示例：`docs/PLUGIN_EXAMPLES.md`
- 了解插件 API 文档：`docs/PLUGIN_API.md`
- 开发自定义 Tauri 命令：`docs/PLUGIN_RUST.md`
