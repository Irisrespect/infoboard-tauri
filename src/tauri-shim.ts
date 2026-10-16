import { invoke } from '@tauri-apps/api/core'
import * as autostart from './core/autostart-bridge'

/** 将旧版 Electron IPC 映射到 Tauri invoke */
export function initTauriShim() {
  window.electronAPI = {
    minimize: () => invoke<void>('window_minimize'),
    maximize: () => invoke<void>('window_maximize'),
    close: () => invoke<void>('window_close'),
    isMaximized: () => invoke<boolean>('window_is_maximized'),
    isVisible: () => invoke<boolean>('window_is_visible'),
    platform: 'win32',
    geolocate: () => invoke<GeolocateResult>('geolocate_ip'),
    toggleTitleBar: async () => {
      window.dispatchEvent(new CustomEvent('toggle-titlebar'))
      return true
    },
    titleBarVisible: async () => true,
    setAutoStart: (enabled: boolean) => autostart.setEnabled(enabled).then(() => true),
    getAutoStart: () => autostart.isEnabled(),
    startScreenshot: () => invoke('screenshot_start'),
    confirmScreenshot: (dataUrl: string) => invoke('screenshot_confirm', { dataUrl }),
    cancelScreenshot: () => invoke('screenshot_cancel'),
    onScreenData: (cb: (dataUrl: string) => void) => {
      invoke('screenshot_get_image').then((v) => {
        if (typeof v === 'string') cb(v)
      })
    },
    ocrRecognize: async (imageBase64: string) =>
      invoke<OcrResponse>('ocr_recognize', { imageBase64 }),
  }

  window.toastAPI = {
    show: (data) => {
      window.dispatchEvent(new CustomEvent('toast-show', { detail: data }))
    },
  }
}
