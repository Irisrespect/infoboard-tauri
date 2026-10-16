# 外部插件 API 文档

本文档详细说明外部插件的所有可用 API 和最佳实践。

## 核心类型

### PluginManifest

插件元数据配置对象。

```typescript
interface PluginManifest {
  id: string                    // 唯一标识（必填）
  name: string                  // 显示名称（必填）
  section: 'info' | 'tool'      // 所属区域（必填）
  icon: string                  // 图标 emoji 或路径（必填）
  badge?: number | string       // 角标数字或文本
  color?: string                // 主题色（CSS 颜色值）
  style?: Record<string, string> // 自定义 CSS 样式
  version?: string              // 版本号
  author?: string               // 作者信息
  description?: string          // 插件描述
}
```

### InfoBoardPlugin

完整的插件导出对象。

```typescript
interface InfoBoardPlugin {
  manifest: PluginManifest
  Component: React.ComponentType<PluginComponentProps>
  onInit?: () => void
  onDestroy?: () => void
  type?: 'builtin' | 'external'
  sourcePath?: string
}
```

### PluginComponentProps

插件组件接收的 props。

```typescript
interface PluginComponentProps {
  manifest: PluginManifest
  expanded?: boolean  // 工具区插件是否展开
}
```

## 插件注册表 API

### pluginRegistry

全局单例，管理所有已注册的插件。

```typescript
import { pluginRegistry } from '@/core/PluginRegistry'

// 获取指定插件
const plugin = pluginRegistry.get('plugin-id')

// 获取所有插件
const allPlugins = pluginRegistry.getAll()

// 按区域查询
const infoPlugins = pluginRegistry.getBySection('info')
const toolPlugins = pluginRegistry.getBySection('tool')

// 检查插件是否存在
if (pluginRegistry.hasPlugin('weather')) {
  // ...
}

// 获取插件数量
const count = pluginRegistry.size
```

## Tauri API

外部插件可以调用所有 Tauri API。

### 调用 Rust 命令

```typescript
import { invoke } from '@tauri-apps/api/core'

// 调用自定义命令
const result = await invoke<string>('my_command', {
  arg1: 'value1',
  arg2: 123
})

// 调用内置命令
const data = await invoke('opencode_get_usage')
```

### 访问剪贴板

```typescript
import { writeText, readText } from '@tauri-apps/plugin-clipboard-manager'

// 写入剪贴板
await writeText('Hello, World!')

// 读取剪贴板
const text = await readText()
```

### 存储数据

```typescript
import { Store } from '@tauri-apps/plugin-store'

const store = new Store('my-plugin.json')

// 保存数据
await store.set('key', { value: 'data' })

// 读取数据
const value = await store.get('key')

// 删除数据
await store.delete('key')

// 保存到磁盘
await store.save()
```

### 监听事件

```typescript
import { listen } from '@tauri-apps/api/event'

// 监听自定义事件
const unlisten = await listen<string>('my-event', (event) => {
  console.log('收到事件:', event.payload)
})

// 取消监听
unlisten()
```

## React Hooks

### useState / useEffect

标准 React hooks。

```typescript
import { useState, useEffect } from 'react'

function MyPlugin() {
  const [data, setData] = useState(null)

  useEffect(() => {
    // 组件挂载时执行
    fetchData().then(setData)

    // 清理函数
    return () => {
      // 组件卸载时执行
    }
  }, [])

  return <div>{data}</div>
}
```

### 自定义 Hook

```typescript
function usePluginData(pluginId: string) {
  const [plugin, setPlugin] = useState(null)

  useEffect(() => {
    const p = pluginRegistry.get(pluginId)
    setPlugin(p)
  }, [pluginId])

  return plugin
}
```

## 样式

### Tailwind CSS

插件可以使用项目的 Tailwind 类。

```tsx
<div className="p-4 bg-surface-1 rounded-lg shadow-sm">
  <h2 className="text-lg font-semibold text-text-primary">标题</h2>
  <p className="text-sm text-text-muted">描述</p>
</div>
```

### 内联样式

```tsx
<div
  style={{
    padding: '16px',
    backgroundColor: '#f5f5f5',
    borderRadius: '8px',
  }}
>
  内容
</div>
```

### CSS Modules（不推荐）

外部插件无法使用 CSS Modules，建议使用 Tailwind 或内联样式。

## 最佳实践

### 1. 错误处理

始终捕获异步操作的错误。

```typescript
Component: () => {
  const [error, setError] = useState(null)

  const fetchData = async () => {
    try {
      const result = await invoke('command')
      // 处理结果
    } catch (err) {
      setError(err.message)
      console.error('[MyPlugin] 错误:', err)
    }
  }

  if (error) {
    return <div>加载失败: {error}</div>
  }

  return <div>...</div>
}
```

### 2. 加载状态

提供友好的加载反馈。

```typescript
const [loading, setLoading] = useState(true)
const [data, setData] = useState(null)

useEffect(() => {
  fetchData()
    .then(setData)
    .finally(() => setLoading(false))
}, [])

if (loading) {
  return <div>加载中...</div>
}
```

### 3. 性能优化

避免不必要的重新渲染。

```typescript
// 使用 useMemo 缓存计算结果
const computed = useMemo(() => {
  return expensiveComputation(data)
}, [data])

// 使用 useCallback 缓存函数
const handleClick = useCallback(() => {
  // 处理点击
}, [])
```

### 4. 清理资源

组件卸载时清理订阅和定时器。

```typescript
useEffect(() => {
  const timer = setInterval(() => {
    // 定时任务
  }, 1000)

  const unlisten = await listen('event', handler)

  // 清理
  return () => {
    clearInterval(timer)
    unlisten()
  }
}, [])
```

### 5. 类型安全

使用 TypeScript 类型注解。

```typescript
interface MyData {
  id: number
  name: string
}

const [data, setData] = useState<MyData | null>(null)
```

## 调试

### Console 日志

```typescript
console.log('[MyPlugin] 初始化')
console.error('[MyPlugin] 错误:', error)
console.warn('[MyPlugin] 警告:', message)
```

### 浏览器开发者工具

按 F12 打开开发者工具，可以：
- 查看 Console 日志
- 设置断点调试
- 检查网络请求
- 查看 React 组件树

### Rust 日志

在 Rust 侧使用 `println!` 或日志宏：

```rust
println!("[MyPlugin] Rust 日志");
```

## 限制

### 不支持的功能

1. **Node.js API**: 无法使用 `fs`、`path` 等 Node.js 模块
2. **CSS Modules**: 无法导入 `.module.css` 文件
3. **动态导入**: 避免使用 `import()`
4. **Web Worker**: 暂不支持

### 安全限制

外部插件在主进程沙箱中运行，可以：
- 访问所有 Tauri API
- 调用已注册的 Rust 命令
- 读写本地存储
- 访问剪贴板

但无法：
- 执行任意系统命令
- 访问文件系统任意路径
- 发起不受限的网络请求（受 CSP 限制）

## 完整示例

一个包含所有最佳实践的完整插件：

```typescript
import type { InfoBoardPlugin } from '@/core/types'
import { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'

interface PluginData {
  count: number
  message: string
}

function MyPluginComponent() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<PluginData | null>(null)

  useEffect(() => {
    let mounted = true

    const fetchData = async () => {
      try {
        const result = await invoke<PluginData>('my_plugin_fetch_data')
        if (mounted) {
          setData(result)
        }
      } catch (err) {
        if (mounted) {
          setError(err instanceof Error ? err.message : String(err))
        }
      } finally {
        if (mounted) {
          setLoading(false)
        }
      }
    }

    fetchData()

    return () => {
      mounted = false
    }
  }, [])

  if (loading) {
    return (
      <div className="p-4 text-center text-text-muted">
        加载中...
      </div>
    )
  }

  if (error) {
    return (
      <div className="p-4 text-center text-red-500">
        加载失败: {error}
      </div>
    )
  }

  return (
    <div className="p-4 bg-surface-1 rounded-lg">
      <h2 className="text-lg font-semibold mb-2">
        {data?.message}
      </h2>
      <p className="text-text-muted">
        计数: {data?.count}
      </p>
    </div>
  )
}

const MyPlugin: InfoBoardPlugin = {
  manifest: {
    id: 'my-plugin',
    name: '我的插件',
    version: '1.0.0',
    section: 'info',
    icon: '🔧',
  },

  Component: MyPluginComponent,

  onInit: () => {
    console.log('[MyPlugin] 插件初始化')
  },

  onDestroy: () => {
    console.log('[MyPlugin] 插件销毁')
  },
}

export default MyPlugin
```

## 下一步

- 查看 [插件开发教程](PLUGIN_TUTORIAL.md) 了解完整开发流程
- 查看 `plugins/hello-world/` 示例插件
- 查看 `src/plugins/` 内置插件源码

## 常见问题

**Q: 如何访问其他插件的数据？**

A: 通过 `pluginRegistry.get('plugin-id')` 获取插件实例，但要注意插件可能未加载。

**Q: 如何持久化插件配置？**

A: 使用 Tauri Store 或 localStorage。

**Q: 如何添加自定义 Rust 命令？**

A: 编写 Rust 函数并在 `lib.rs` 中注册（需要重新编译）。

**Q: 插件可以相互通信吗？**

A: 可以通过事件系统或共享状态实现。

**Q: 如何处理插件更新？**

A: 目前需要手动替换插件文件夹并重启应用。
