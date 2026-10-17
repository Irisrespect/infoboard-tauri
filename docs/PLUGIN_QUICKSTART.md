# 插件开发快速入门

5 分钟创建你的第一个 InfoBoard 插件。

## 第一步：创建插件目录

插件放在用户数据目录（首次启动应用会自动创建），不是仓库里的 `plugins/`：

```bash
cd "$APPDATA/com.infoboard.tauri/plugins"
mkdir my-first-plugin
cd my-first-plugin
```

PowerShell 用户：`cd "$env:APPDATA\com.infoboard.tauri\plugins"`。

## 第二步：创建 manifest.json

```json
{
  "id": "my-first-plugin",
  "name": "我的第一个插件",
  "version": "1.0.0",
  "author": "Your Name",
  "description": "这是我的第一个插件",
  "section": "info",
  "icon": "🎉",
  "entry": "index.tsx"
}
```

**重要字段说明:**

- `id`: 必须唯一，推荐全小写加连字符
- `section`: `"info"` 放在信息区，`"tool"` 放在工具区
- `entry`: 入口文件，相对于插件目录

## 第三步：创建 index.tsx

```tsx
import type { InfoBoardPlugin } from '../../src/core/types'

const MyFirstPlugin: InfoBoardPlugin = {
  manifest: {
    id: 'my-first-plugin',
    name: '我的第一个插件',
    version: '1.0.0',
    section: 'info',
    icon: '🎉',
  },

  Component: () => {
    return (
      <div style={{ padding: '20px', background: '#4CAF50', color: 'white', borderRadius: '8px' }}>
        <h2>🎉 恭喜！</h2>
        <p>你的第一个插件创建成功了！</p>
      </div>
    )
  },
}

export default MyFirstPlugin
```

## 第四步：重启应用

关闭并重新启动 InfoBoard 应用，你的插件将自动加载。

## 下一步

### 添加交互

```tsx
import { useState } from 'react'

Component: () => {
  const [count, setCount] = useState(0)

  return (
    <div style={{ padding: '20px' }}>
      <p>点击次数: {count}</p>
      <button onClick={() => setCount(count + 1)}>点击我</button>
    </div>
  )
}
```

### 调用 Tauri API

```tsx
import { invoke } from '@tauri-apps/api/core'
import { useState, useEffect } from 'react'

Component: () => {
  const [data, setData] = useState(null)

  useEffect(() => {
    invoke('some_rust_command')
      .then((result) => setData(result))
      .catch((err) => console.error(err))
  }, [])

  return <div>{data ? JSON.stringify(data) : '加载中...'}</div>
}
```

### 使用 Tailwind CSS

```tsx
Component: () => {
  return (
    <div className="p-6 bg-surface-1 rounded-xl shadow-lg">
      <h2 className="text-xl font-bold text-text-primary mb-2">标题</h2>
      <p className="text-text-muted">使用 Tailwind 类名快速构建 UI</p>
    </div>
  )
}
```

### 定时更新

```tsx
import { useState, useEffect } from 'react'

Component: () => {
  const [time, setTime] = useState(new Date())

  useEffect(() => {
    const timer = setInterval(() => {
      setTime(new Date())
    }, 1000)

    // 清理定时器
    return () => clearInterval(timer)
  }, [])

  return <div>当前时间: {time.toLocaleTimeString()}</div>
}
```

## 常见问题

**Q: 插件没有显示怎么办？**

1. 检查 `manifest.json` 格式是否正确
2. 查看控制台是否有错误日志（F12）
3. 确认 `id` 没有与其他插件重复
4. 检查 `entry` 文件路径是否正确

**Q: 如何调试插件？**

按 F12 打开开发者工具，使用 `console.log` 输出日志。

**Q: 插件可以访问哪些 API？**

- React（`react`、`react/jsx-runtime`、`react-dom`）
- Tauri 的 `invoke` / 事件（`@tauri-apps/api/core`、`@tauri-apps/api/event`）
- 仅限单文件；不支持相对路径 import 和其他 npm 包

**Q: 如何热重载插件？**

目前需要重启应用。未来会添加热重载功能。

## 示例插件

查看这些示例学习更多：

- `plugins/hello-world/` - 最简单的示例
- `plugins/system-info/` - 定时更新和状态管理
- `src/plugins/weather/` - 完整的内置插件

## 更多资源

- [完整教程](PLUGIN_TUTORIAL.md)
- [API 文档](PLUGIN_API.md)
- [插件模板](../plugins/.plugin-template/)

开始创造吧！🚀
