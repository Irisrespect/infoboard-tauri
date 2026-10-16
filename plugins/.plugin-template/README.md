# InfoBoard 插件开发模板

这是一个最小的插件模板，包含所有必需文件。

## 使用方法

1. 复制整个 `.plugin-template/` 目录到 `plugins/your-plugin-name/`
2. 修改 `manifest.json` 中的 `id`、`name` 等字段
3. 在 `index.tsx` 中实现你的插件逻辑
4. 重启 InfoBoard 应用

## 文件说明

- **manifest.json**: 插件元数据（必须）
- **index.tsx**: 插件入口文件（必须）
- **package.json**: npm 依赖配置（可选）
- **README.md**: 插件说明文档（推荐）

## 开发提示

### 1. 修改 manifest.json

```json
{
  "id": "unique-plugin-id",    // 唯一标识，不能与其他插件重复
  "name": "插件显示名称",
  "version": "1.0.0",
  "section": "info"             // 'info' 信息区 或 'tool' 工具区
}
```

### 2. 编写插件组件

```tsx
function MyPluginComponent(props: PluginComponentProps) {
  const [data, setData] = useState(null)

  useEffect(() => {
    // 组件挂载时执行
    fetchData()
  }, [])

  return <div>...</div>
}
```

### 3. 调用 Tauri API

```tsx
import { invoke } from '@tauri-apps/api/core'

async function fetchData() {
  const result = await invoke('some_rust_command')
  console.log(result)
}
```

### 4. 访问其他插件

```tsx
import { pluginRegistry } from '../../src/core/PluginRegistry'

const weatherPlugin = pluginRegistry.get('weather')
```

## 完整教程

查看 [`docs/PLUGIN_TUTORIAL.md`](../../docs/PLUGIN_TUTORIAL.md) 获取详细教程。

## 许可

MIT
