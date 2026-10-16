/**
 * 灵动岛插件导出
 *
 * 组合 manifest + Component，导出完整的 InfoBoardPlugin
 */

import type { InfoBoardPlugin } from '../../core/types'
import { manifest } from './manifest'
import { DynamicIsland } from './DynamicIsland'

export const dynamicIslandPlugin: InfoBoardPlugin = {
  manifest,
  Component: DynamicIsland,
  onInit: () => {
    console.log('[灵动岛插件] 已加载')
  },
}

// 单独导出，方便其他地方按需引用
export { manifest } from './manifest'
export { DynamicIsland } from './DynamicIsland'
export { PillCollapsed } from './PillCollapsed'
export { MediaControls } from './MediaControls'
export { useMediaControl, formatPlaybackStatus } from './useMediaControl'
export type {
  PillState,
  MediaSession,
  IslandState,
  MockDataType,
  MockConfig,
} from './types'
