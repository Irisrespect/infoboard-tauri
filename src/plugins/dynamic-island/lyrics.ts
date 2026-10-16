/**
 * 歌词工具（纯函数，便于单测）
 */

export interface LyricLine {
  time: number
  text: string
}

/**
 * 按当前播放进度算当前歌词行下标。
 *
 * - 空歌词 → -1
 * - 没有一行 time > 0（非同步歌词，如纯文本 LRC 缺失时间轴）→ -1
 * - 进度早于第一行时间 → -1
 */
export function findCurrentLyricIndex(lyrics: LyricLine[], position: number): number {
  if (lyrics.length === 0) return -1
  if (!lyrics.some((l) => l.time > 0)) return -1

  let index = -1
  for (let i = 0; i < lyrics.length; i++) {
    if (lyrics[i].time <= position) index = i
    else break
  }
  return index
}
