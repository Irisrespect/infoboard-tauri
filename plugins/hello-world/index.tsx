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
  },

  Component: () => {
    return (
      <div
        style={{
          padding: '24px',
          background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
          borderRadius: '12px',
          color: 'white',
          textAlign: 'center',
        }}
      >
        <h1 style={{ fontSize: '32px', marginBottom: '12px' }}>👋 Hello, World!</h1>
        <p style={{ fontSize: '16px', opacity: 0.9, marginBottom: '8px' }}>
          这是一个外部插件示例。
        </p>
        <p style={{ fontSize: '14px', opacity: 0.8 }}>
          你可以在这里添加任何 React 组件。
        </p>
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
