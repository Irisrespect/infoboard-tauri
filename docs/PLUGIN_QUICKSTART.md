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

> 也可以把插件打包成 `.ibplugin` 让使用者拖进「设置 → 插件管理」安装，
> 见 [打包与分发](#第六步打包分发给别人装)。

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

- `id`: 必须唯一，推荐全小写加连字符；**不能与内置插件重名**（weather / todo / settings / dynamic-island / screenshot / translate）
- `section`: `"info"` 放在信息区，`"tool"` 放在工具区
- `entry`: 入口文件，相对于插件目录，如 `index.tsx`；不能是绝对路径或含 `..`
- `tauriCommands`: **要用 `invoke` 就必须在这里声明命令名**，下面会讲

## 第三步：创建 index.tsx

```tsx
// 注意：`import type` 会在运行时被擦除，所以引用核心类型是安全的
import type { InfoBoardPlugin } from '@/core/types'

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

## 第四步：重新加载插件

**不用重启应用**：打开 **设置 → 插件管理 → 重新加载插件**，插件立即生效。

（改完源码点一下这个按钮即可看到效果，这也是开发时的主要工作流。）

## 第五步：（可选）打包分发给别人装

把插件目录压成单个 `.ibplugin` 文件，别人在 **设置 → 插件管理** 里**拖进去**就装好了：

```bash
node scripts/pack-plugin.mjs <插件目录>       # 例如 plugins/hello-world
# 产出 dist-plugins/<id>-<version>.ibplugin
```

`.ibplugin` 就是一个 zip：根目录放 `manifest.json` 和入口文件（入口名由 manifest 的 `entry` 指定）。
对方不需要知道文件夹在哪，也不需要重启。

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

**必须先在 `manifest.json` 里声明要调用的命令**，否则运行时会被拒绝：

```json
{
  "id": "my-first-plugin",
  "tauriCommands": ["window_is_active", "ocr_is_ready"]
}
```

```tsx
import { invoke } from '@tauri-apps/api/core'
import { useState, useEffect } from 'react'

Component: () => {
  const [active, setActive] = useState<boolean | null>(null)

  useEffect(() => {
    // window_is_active 已在上面 manifest.json 的 tauriCommands 里声明过
    invoke<boolean>('window_is_active')
      .then(setActive)
      .catch((err) => console.error('调用失败:', err))
  }, [])

  return <div>窗口活跃: {active === null ? '查询中…' : String(active)}</div>
}
```

没声明（或声明为空数组）时**所有 invoke 都会被拒绝**，报错信息里会告诉你去
`tauriCommands` 补哪条。可用的命令名见 [PLUGIN_API](PLUGIN_API.md) 的命令清单。

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
- Tauri 的 `invoke`（`@tauri-apps/api/core`）—— 但**只能在 manifest 的 `tauriCommands` 里声明过的命令**
- 仅限单文件；不支持相对路径 import 和其他 npm 包

**注意**：`@tauri-apps/api/event` **不在白名单**（插件不应监听宿主事件，
例如 `screenshot:data`）。import 它会直接报错并列出可用模块。

**Q: 怎么让插件生效？**

打开 **设置 → 插件管理 → 重新加载插件** 即可，不需要重启应用。
卸载插件也在同一个位置（插件列表里点「卸载」）。

**Q: 怎么把自己写的插件发给别人？**

```bash
node scripts/pack-plugin.mjs <插件目录>
```

产出 `.ibplugin` 文件，对方在 设置 → 插件管理 里拖进去就装好了。
详见 [第五步](#第五步可选打包分发给别人装)。

**Q: 安装后插件没出现怎么办？**

按 **F12** 打开应用内日志台，`[PluginLoader]` 会打印具体原因
（缺 manifest.json / 入口不存在 / 转译失败等），比盲猜快。
导入 `.ibplugin` 失败时，界面会直接弹出错误原因。

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
