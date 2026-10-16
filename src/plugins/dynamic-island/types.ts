/**
 * 灵动岛插件 — 类型定义
 *
 * 定义所有数据结构和状态类型
 */

// ─── 灵动岛总体状态 ───

/** 灵动岛状态类型 */
export type PillState =
  | 'idle' // 空闲态：无媒体播放
  | 'media-playing' // 播放态：检测到媒体播放

// ─── 媒体会话相关 ───

/** 媒体播放状态 */
export type PlaybackStatus = 'playing' | 'paused' | 'stopped' | 'closed'

/** 媒体控制命令 */
export type MediaCommand = 'play' | 'pause' | 'toggle' | 'next' | 'previous'

/** SMTC 媒体会话信息 */
export interface MediaSession {
  /** 视频标题 */
  title: string

  /** UP主 / 频道名 */
  artist: string

  /** 缩略图 base64 或路径 */
  thumbnail?: string

  /** 播放状态 */
  playbackStatus: PlaybackStatus

  /** 来源应用（如 'bilibili.exe'） */
  sourceAppId?: string

  /** 播放进度（秒） */
  position?: number

  /** 总时长（秒） */
  duration?: number

  /** UP主头像 URL（B站来源时可用） */
  ownerAvatar?: string
}

// ─── 灵动岛内部状态 ───

/** 灵动岛内部状态 */
export interface IslandState {
  /** 当前 pill 状态 */
  pillState: PillState

  /** 当前媒体会话 */
  currentMedia: MediaSession | null

  /** 是否展开（点击展开） */
  isExpanded: boolean
}

// ─── Mock 数据相关 ───

/** Mock 数据类型 */
export type MockDataType = 'media' | 'clear'

/** Mock 配置 */
export interface MockConfig {
  /** 是否启用 Mock 模式（仅开发环境） */
  enabled: boolean

  /** Mock 媒体数据 */
  media?: MediaSession
}
