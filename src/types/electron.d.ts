export {}

declare global {
  /** OCR 识别结果 */
  interface OcrResultItem {
    text: string
    box: [number, number][]
    score: number
  }

  interface OcrResponse {
    code: number
    data: OcrResultItem[] | string
  }

  /** 系统/IP 定位结果 */
  type GeolocateResult =
    | { lat: number; lon: number }
    | { latitude: number; longitude: number }
    | { error: string; reason?: string }
    | null

  interface ElectronAPI {
    minimize: () => Promise<void>
    maximize: () => Promise<void>
    close: () => Promise<void>
    isMaximized: () => Promise<boolean>
    isVisible: () => Promise<boolean>
    platform: string
    geolocate: () => Promise<GeolocateResult>
    toggleTitleBar: () => Promise<boolean>
    titleBarVisible: () => Promise<boolean>
    setAutoStart: (enabled: boolean) => Promise<boolean>
    getAutoStart: () => Promise<boolean>
    startScreenshot: () => void
    confirmScreenshot: (dataUrl: string) => void
    cancelScreenshot: () => void
    onScreenData: (callback: (dataUrl: string) => void) => void
    ocrRecognize: (dataUrl: string) => Promise<OcrResponse>
  }

  interface ToastAPI {
    /** action 会原样透传给 GlobalToast（如「撤销」按钮；带 action 时默认停留 8000ms） */
    show: (data: {
      message: string
      color?: string
      bg?: string
      duration?: number
      action?: { label: string; onClick: () => void }
    }) => void
  }

  interface ClipboardBridge {
    writeText: (text: string) => Promise<void>
  }

  interface TranslateApiBridge {
    translate: (...args: unknown[]) => Promise<unknown>
    [key: string]: unknown
  }

  interface Window {
    electronAPI: ElectronAPI
    deeplAPI?: TranslateApiBridge
    niutransAPI?: TranslateApiBridge
    clipboard?: ClipboardBridge
    toastAPI: ToastAPI
  }
}
