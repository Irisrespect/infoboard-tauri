/**
 * 截图覆盖窗口入口
 *
 * 加载后 emit screenshot:ready，后端再推图并 show。
 * 同时 listen screenshot:data + get_image 兜底。
 */

import { useEffect, useState } from 'react'
import { ScreenshotOverlay } from '../plugins/screenshot/ScreenshotOverlay'
import { errorMessage } from '../core/errorMessage'
import { invoke } from '@tauri-apps/api/core'
import { emit, listen } from '@tauri-apps/api/event'

export function ScreenshotOverlayWindow() {
  const [image, setImage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let unlisten: (() => void) | undefined
    let cancelled = false

    ;(async () => {
      try {
        unlisten = await listen<string>('screenshot:data', (event) => {
          if (!cancelled) {
            setImage(event.payload)
            setError(null)
          }
        })
        // 通知后端：监听已就绪
        await emit('screenshot:ready')
        // 兜底拉图
        const v = await invoke<string | null>('screenshot_get_image')
        if (!cancelled && v) setImage(v)
      } catch (e) {
        // String(e) 遇到对象型拒绝值会渲染成 [object Object]，用户看不到原因
        if (!cancelled) setError(errorMessage(e))
      }
    })()

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  if (!image && !error) {
    return <div className="fixed inset-0" style={{ background: 'transparent' }} />
  }

  if (error) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-black/80 z-50">
        <p className="text-red-400 text-sm">{error}</p>
      </div>
    )
  }

  return <ScreenshotOverlay initialImage={image!} onClose={() => setImage(null)} />
}
