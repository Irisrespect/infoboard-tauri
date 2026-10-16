import type { InfoBoardPlugin } from '../../src/core/types'
import { useState, useEffect } from 'react'

interface SystemInfo {
  platform: string
  arch: string
  memory: {
    total: number
    used: number
  }
  uptime: number
}

function SystemInfoComponent() {
  const [info, setInfo] = useState<SystemInfo | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // 模拟获取系统信息
    const mockInfo: SystemInfo = {
      platform: 'Windows',
      arch: 'x64',
      memory: {
        total: 16384,
        used: 8192,
      },
      uptime: Math.floor(Date.now() / 1000),
    }

    setTimeout(() => {
      setInfo(mockInfo)
      setLoading(false)
    }, 500)

    // 定时更新
    const timer = setInterval(() => {
      setInfo((prev) =>
        prev
          ? {
              ...prev,
              memory: {
                ...prev.memory,
                used: prev.memory.used + Math.random() * 100 - 50,
              },
            }
          : null
      )
    }, 2000)

    return () => clearInterval(timer)
  }, [])

  if (loading) {
    return (
      <div
        style={{
          padding: '24px',
          textAlign: 'center',
          color: '#999',
        }}
      >
        加载中...
      </div>
    )
  }

  if (!info) {
    return <div style={{ padding: '24px', color: '#f00' }}>加载失败</div>
  }

  const memoryPercent = ((info.memory.used / info.memory.total) * 100).toFixed(1)

  return (
    <div
      style={{
        padding: '20px',
        background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
        borderRadius: '12px',
        color: 'white',
      }}
    >
      <div style={{ fontSize: '24px', fontWeight: 'bold', marginBottom: '16px' }}>
        💻 系统信息
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div>
          <div style={{ fontSize: '12px', opacity: 0.8 }}>平台</div>
          <div style={{ fontSize: '16px', fontWeight: '600' }}>
            {info.platform} ({info.arch})
          </div>
        </div>

        <div>
          <div style={{ fontSize: '12px', opacity: 0.8 }}>内存使用</div>
          <div style={{ fontSize: '16px', fontWeight: '600' }}>
            {info.memory.used.toFixed(0)} MB / {info.memory.total} MB ({memoryPercent}%)
          </div>
          <div
            style={{
              marginTop: '8px',
              height: '6px',
              background: 'rgba(255,255,255,0.2)',
              borderRadius: '3px',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: `${memoryPercent}%`,
                height: '100%',
                background: 'rgba(255,255,255,0.9)',
                transition: 'width 0.3s ease',
              }}
            />
          </div>
        </div>

        <div>
          <div style={{ fontSize: '12px', opacity: 0.8 }}>运行时间</div>
          <div style={{ fontSize: '16px', fontWeight: '600' }}>
            {Math.floor(info.uptime / 3600)} 小时
          </div>
        </div>
      </div>
    </div>
  )
}

const SystemInfoPlugin: InfoBoardPlugin = {
  manifest: {
    id: 'system-info',
    name: '系统信息',
    version: '1.0.0',
    author: 'InfoBoard Team',
    description: '显示系统信息和性能指标',
    section: 'info',
    icon: '💻',
    entry: 'index.tsx',
  },

  Component: SystemInfoComponent,

  onInit: () => {
    console.log('[SystemInfo] 插件初始化')
  },

  onDestroy: () => {
    console.log('[SystemInfo] 插件销毁')
  },
}

export default SystemInfoPlugin
