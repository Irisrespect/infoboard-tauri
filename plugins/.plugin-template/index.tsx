import type { InfoBoardPlugin, PluginComponentProps } from '../../src/core/types'

/**
 * 插件组件
 *
 * 可以使用 props.manifest 访问插件配置
 */
function MyPluginComponent(props: PluginComponentProps) {
  return (
    <div style={{ padding: '16px' }}>
      <h2>{props.manifest.name}</h2>
      <p>插件 ID: {props.manifest.id}</p>
      <p>这是一个插件模板，开始编写你的代码吧!</p>
    </div>
  )
}

/**
 * 插件导出
 *
 * 必须符合 InfoBoardPlugin 接口
 */
const MyPlugin: InfoBoardPlugin = {
  manifest: {
    id: 'my-plugin',
    name: '我的插件',
    version: '1.0.0',
    author: 'Your Name',
    description: '插件描述',
    section: 'info', // 'info' 或 'tool'
    icon: '🔧',
    entry: 'index.tsx',
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
