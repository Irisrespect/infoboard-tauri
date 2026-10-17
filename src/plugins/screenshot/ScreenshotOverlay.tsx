/**
 * 截图覆盖层组件
 *
 * 工作流程：
 * 1. 覆盖窗收到 initialImage（xcap 原生截图）→ 显示覆盖层
 * 2. 用户框选区域 → 选区内显示原图（无遮罩）
 * 3. 确认 → Canvas 裁剪 → 剪贴板 + 关闭覆盖窗
 * 4. 可选：识别文字（OCR）
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import * as screenshotBridge from './bridge'
import * as ocrBridge from './ocr-bridge'
import { errorMessage } from '../../core/errorMessage'

interface SelectionRect {
  x: number
  y: number
  width: number
  height: number
}

type OverlayState = 'loading' | 'idle' | 'selecting' | 'selected'

interface ScreenshotOverlayProps {
  onClose: () => void
  initialImage?: string
}

export function ScreenshotOverlay({ onClose, initialImage }: ScreenshotOverlayProps) {
  const [screenImage, setScreenImage] = useState<string | null>(initialImage ?? null)
  const [state, setState] = useState<OverlayState>(initialImage ? 'idle' : 'loading')
  const [startPos, setStartPos] = useState({ x: 0, y: 0 })
  const [currentPos, setCurrentPos] = useState({ x: 0, y: 0 })
  const [selection, setSelection] = useState<SelectionRect | null>(null)
  const [ocrText, setOcrText] = useState<string | null>(null)
  const [ocrLoading, setOcrLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)

  const calcRect = useCallback(
    (sx: number, sy: number, ex: number, ey: number): SelectionRect => ({
      x: Math.min(sx, ex),
      y: Math.min(sy, ey),
      width: Math.abs(ex - sx),
      height: Math.abs(ey - sy),
    }),
    []
  )

  // 取消
  const handleCancel = useCallback(() => {
    screenshotBridge.cancel().catch(() => {})
    setOcrText(null)
    setError(null)
    onClose()
  }, [onClose])

  const handleCancelRef = useRef(handleCancel)
  handleCancelRef.current = handleCancel

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button === 2) {
        handleCancel()
        return
      }
      if (state === 'selected') return // 已选中的情况下不允许重新选择（必须取消或确认）
      if (state !== 'idle') return
      setStartPos({ x: e.clientX, y: e.clientY })
      setCurrentPos({ x: e.clientX, y: e.clientY })
      setOcrText(null)
      setError(null)
      setState('selecting')
    },
    [state, handleCancel]
  )

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (state !== 'selecting') return
      setCurrentPos({ x: e.clientX, y: e.clientY })
    },
    [state]
  )

  const handleMouseUp = useCallback(() => {
    if (state !== 'selecting') return
    const rect = calcRect(startPos.x, startPos.y, currentPos.x, currentPos.y)
    if (rect.width < 5 || rect.height < 5) {
      setState('idle')
      return
    }
    setSelection(rect)
    setState('selected')
  }, [state, startPos, currentPos, calcRect])

  // 最新坐标的快照：document 级兜底回调里必须读到最新值，不能依赖闭包捕获
  const startPosRef = useRef(startPos)
  startPosRef.current = startPos
  const currentPosRef = useRef(currentPos)
  currentPosRef.current = currentPos

  // 松手兜底：拖拽时把指针移出窗口外再松手，覆盖层的 onMouseUp 收不到事件，
  // 会永远停在 'selecting'（之后再按左键也不响应，等于截图卡死）。
  // 这里在 document 上监听 pointerup / pointercancel，并用最后一帧坐标结算。
  useEffect(() => {
    if (state !== 'selecting') return

    const settle = () => {
      const rect = calcRect(
        startPosRef.current.x,
        startPosRef.current.y,
        currentPosRef.current.x,
        currentPosRef.current.y
      )
      if (rect.width < 5 || rect.height < 5) {
        setState('idle')
        return
      }
      setSelection(rect)
      setState('selected')
    }

    document.addEventListener('pointerup', settle)
    document.addEventListener('pointercancel', settle)
    // 指针移出窗口后 WebView 可能不再转发 pointer 事件，窗口失焦作为最后兜底
    window.addEventListener('blur', settle)
    return () => {
      document.removeEventListener('pointerup', settle)
      document.removeEventListener('pointercancel', settle)
      window.removeEventListener('blur', settle)
    }
  }, [state, calcRect])

  // 键盘事件处理
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleCancelRef.current()
      if (e.key === 'Enter' && state === 'selected') {
        handleWriteClipboardRef.current()
      }
    }
    const ctx = (e: MouseEvent) => {
      e.preventDefault()
      handleCancelRef.current()
    }
    window.addEventListener('keydown', handler)
    window.addEventListener('contextmenu', ctx)
    return () => {
      window.removeEventListener('keydown', handler)
      window.removeEventListener('contextmenu', ctx)
    }
  }, [state])

  // 挂载时截图（仅当无 initialImage）
  useEffect(() => {
    if (initialImage) return

    let cancelled = false
    const load = async () => {
      try {
        const dataUrl = await screenshotBridge.captureOnly()
        if (!cancelled) {
          setScreenImage(dataUrl)
          setState('idle')
        }
      } catch (err) {
        if (!cancelled) {
          setError(errorMessage(err))
          setState('idle')
        }
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [initialImage])

  // 裁剪选区并写入剪贴板
  const handleWriteClipboard = useCallback(async () => {
    if (!selection || !screenImage) return

    try {
      const img = new Image()
      img.src = screenImage

      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve()
        img.onerror = () => reject(new Error('图片加载失败'))
      })

      // 🔴 计算缩放比例：截图以 object-fill 显示在窗口中，窗口坐标 ≠ 图像像素坐标
      const imgEl = imgRef.current
      if (!imgEl) throw new Error('图片元素未挂载')
      const scaleX = img.naturalWidth / imgEl.clientWidth
      const scaleY = img.naturalHeight / imgEl.clientHeight

      // Canvas 裁剪
      const canvas = document.createElement('canvas')
      const sx = Math.round(selection.x * scaleX)
      const sy = Math.round(selection.y * scaleY)
      const sw = Math.round(selection.width * scaleX)
      const sh = Math.round(selection.height * scaleY)
      canvas.width = sw
      canvas.height = sh
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('无法创建 Canvas 上下文')

      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh)

      // 获取裁剪后的 Blob
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
      if (!blob) throw new Error('Canvas 导出失败')

      // 先尝试用 navigator.clipboard.write()（浏览器 API）
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      } catch {
        // 降级：通过后端写入剪贴板（含关闭覆盖窗口）
        const dataUrl = canvas.toDataURL('image/png')
        await screenshotBridge.confirm(dataUrl)
        return
      }
      // 浏览器剪贴板成功 → 仅关闭覆盖窗（语义上不是 cancel）
      await screenshotBridge.closeOverlay()

      onClose()
    } catch (err) {
      console.error('[截图] 写入剪贴板失败:', err)
      setError(errorMessage(err))
    }
  }, [selection, screenImage, onClose])

  const handleWriteClipboardRef = useRef(handleWriteClipboard)
  handleWriteClipboardRef.current = handleWriteClipboard

  // OCR 识别
  const handleOcr = useCallback(async () => {
    if (!selection || !screenImage) return

    setOcrLoading(true)
    setOcrText(null)
    setError(null)

    try {
      const img = new Image()
      img.src = screenImage
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve()
        img.onerror = () => reject(new Error('图片加载失败'))
      })

      // 计算缩放比例（与 handleWriteClipboard 逻辑一致）
      const imgEl = imgRef.current
      if (!imgEl) throw new Error('图片元素未挂载')
      const scaleX = img.naturalWidth / imgEl.clientWidth
      const scaleY = img.naturalHeight / imgEl.clientHeight

      // 裁剪选区
      const canvas = document.createElement('canvas')
      const sx = Math.round(selection.x * scaleX)
      const sy = Math.round(selection.y * scaleY)
      const sw = Math.round(selection.width * scaleX)
      const sh = Math.round(selection.height * scaleY)
      canvas.width = sw
      canvas.height = sh
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('无法创建 Canvas 上下文')

      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh)

      // 转为 base64（去掉 data URL 前缀）
      const dataUrl = canvas.toDataURL('image/png')
      const base64 = dataUrl.split(',')[1] || ''

      // 调用 OCR
      const response = await ocrBridge.recognize(base64)

      if (response.code === 100 && Array.isArray(response.data)) {
        const results: { text: string; score: number }[] = response.data.map((item: unknown) => {
          const obj = item as { text?: string; score?: number }
          return {
            text: obj.text ?? '',
            score: obj.score ?? 0,
          }
        })

        if (results.length === 0) {
          setOcrText('未识别到文字')
        } else {
          const combined = results.map((r) => r.text).join('\n')
          setOcrText(combined)
        }
      } else {
        const errMsg =
          typeof response.data === 'string' ? response.data : `OCR 错误 (code=${response.code})`
        setError(errMsg)
      }
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setOcrLoading(false)
    }
  }, [selection, screenImage])

  const currentRect =
    state === 'selecting' ? calcRect(startPos.x, startPos.y, currentPos.x, currentPos.y) : selection

  const getActionBoxPosition = (rect: SelectionRect) => {
    const offset = 8
    let x = rect.x
    let y = rect.y + rect.height + offset
    if (y + 80 > window.innerHeight) y = rect.y - 80 - offset
    return { left: x, top: y }
  }

  return (
    <div
      className="fixed inset-0 z-50 select-none"
      style={{ cursor: state === 'idle' || state === 'selecting' ? 'crosshair' : 'default' }}
      onMouseDown={state === 'idle' ? handleMouseDown : undefined}
      onMouseMove={handleMouseMove}
      onMouseUp={state === 'selecting' ? handleMouseUp : undefined}
    >
      {/* 截图背景 */}
      {screenImage && (
        <>
          <img
            ref={imgRef}
            src={screenImage}
            alt=""
            className="absolute inset-0 w-full h-full object-fill pointer-events-none select-none"
            draggable={false}
          />
          {/* 暗色遮罩 → 选区位置恢复原图 */}
          {currentRect && currentRect.width > 0 && currentRect.height > 0 ? (
            <>
              <div
                className="absolute left-0 top-0 right-0 pointer-events-none"
                style={{ height: currentRect.y, background: 'rgba(0,0,0,0.45)' }}
              />
              <div
                className="absolute left-0 right-0 bottom-0 pointer-events-none"
                style={{
                  top: currentRect.y + currentRect.height,
                  background: 'rgba(0,0,0,0.45)',
                }}
              />
              <div
                className="absolute pointer-events-none"
                style={{
                  left: 0,
                  top: currentRect.y,
                  width: currentRect.x,
                  height: currentRect.height,
                  background: 'rgba(0,0,0,0.45)',
                }}
              />
              <div
                className="absolute pointer-events-none"
                style={{
                  left: currentRect.x + currentRect.width,
                  top: currentRect.y,
                  right: 0,
                  height: currentRect.height,
                  background: 'rgba(0,0,0,0.45)',
                }}
              />
            </>
          ) : (
            <div
              className="absolute inset-0 pointer-events-none"
              style={{ background: 'rgba(0,0,0,0.08)' }}
            />
          )}
        </>
      )}

      {/* 加载状态 */}
      {!screenImage && !error && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-900/80">
          <div className="flex flex-col items-center gap-3">
            <div className="w-8 h-8 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            <span className="text-white text-sm">正在截取屏幕...</span>
          </div>
        </div>
      )}

      {/* 错误状态 */}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-900/80">
          <div className="flex flex-col items-center gap-3">
            <span className="text-red-400 text-sm">{error}</span>
            <button
              onClick={handleCancel}
              className="px-4 py-1.5 text-xs font-medium text-white rounded-md bg-gray-600 hover:bg-gray-500"
            >
              关闭
            </button>
          </div>
        </div>
      )}

      {/* 选区尺寸标签 */}
      {currentRect && currentRect.width > 0 && currentRect.height > 0 && (
        <div
          className="absolute pointer-events-none"
          style={{
            left: currentRect.x,
            top: currentRect.y - 28,
            background: 'rgba(0,0,0,0.7)',
            borderRadius: 4,
            padding: '3px 8px',
          }}
        >
          <span className="text-white text-xs font-mono">
            {Math.round(currentRect.width)} × {Math.round(currentRect.height)}
          </span>
        </div>
      )}

      {/* 已选中状态操作栏 */}
      {state === 'selected' && selection && (
        <div
          className="absolute flex gap-2 z-10"
          style={{
            left: getActionBoxPosition(selection).left,
            top: getActionBoxPosition(selection).top,
            background: 'rgba(30,30,30,0.92)',
            borderRadius: 8,
            padding: '6px',
            boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
            backdropFilter: 'blur(8px)',
          }}
        >
          <button
            onClick={(e) => {
              e.stopPropagation()
              handleCancel()
            }}
            onMouseDown={(e) => e.stopPropagation()}
            className="px-3 py-1.5 text-xs font-medium rounded-md hover:bg-white/10 transition-colors"
            style={{ color: 'rgba(255,255,255,0.7)' }}
          >
            取消
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation()
              handleOcr()
            }}
            onMouseDown={(e) => e.stopPropagation()}
            disabled={ocrLoading}
            className="px-3 py-1.5 text-xs font-medium rounded-md transition-colors"
            style={{
              color: ocrLoading ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.7)',
              background: 'rgba(255,255,255,0.08)',
            }}
          >
            {ocrLoading ? '识别中...' : '识别文字'}
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation()
              handleWriteClipboard()
            }}
            onMouseDown={(e) => e.stopPropagation()}
            className="px-3 py-1.5 text-xs font-medium text-white rounded-md transition-colors"
            style={{ background: 'var(--accent, #3b82f6)' }}
          >
            确认 ✓
          </button>
        </div>
      )}

      {/* OCR 结果展示 */}
      {ocrText && (
        <div
          className="absolute bottom-16 left-1/2 -translate-x-1/2 z-10 max-w-md w-[90%]"
          style={{
            background: 'rgba(0,0,0,0.85)',
            borderRadius: 8,
            padding: '10px 14px',
            backdropFilter: 'blur(8px)',
          }}
        >
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-green-400 font-medium">OCR 识别结果</span>
            <button
              onClick={() => {
                navigator.clipboard.writeText(ocrText).catch(() => {})
                const event = new CustomEvent('toast-show', {
                  detail: { message: '已复制识别结果' },
                })
                window.dispatchEvent(event)
              }}
              className="text-xs px-2 py-0.5 rounded hover:bg-white/10"
              style={{ color: 'rgba(255,255,255,0.6)' }}
            >
              复制
            </button>
          </div>
          <p className="text-sm text-white whitespace-pre-wrap break-all max-h-32 overflow-y-auto">
            {ocrText}
          </p>
        </div>
      )}

      {/* 底部提示 */}
      <div
        className="absolute flex items-center gap-1.5 pointer-events-none"
        style={{ left: '50%', bottom: 20, transform: 'translateX(-50%)' }}
      >
        <kbd
          className="text-xs px-1.5 py-0.5 rounded"
          style={{
            background: 'rgba(255,255,255,0.15)',
            border: '1px solid rgba(255,255,255,0.25)',
            color: 'rgba(255,255,255,0.6)',
          }}
        >
          Esc
        </kbd>
        <span className="text-xs" style={{ color: 'rgba(255,255,255,0.5)' }}>
          右键 · 取消键 · 退出截图
        </span>
      </div>
    </div>
  )
}
