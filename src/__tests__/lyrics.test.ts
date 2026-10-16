import { describe, it, expect } from 'vitest'
import { findCurrentLyricIndex } from '../plugins/dynamic-island/lyrics'

const lyrics = [
  { time: 0, text: 'a' },
  { time: 5, text: 'b' },
  { time: 10, text: 'c' },
]

describe('findCurrentLyricIndex（原先在 DynamicIsland 里每帧算，现抽成纯函数）', () => {
  it('进度落在某行区间内时返回该行', () => {
    expect(findCurrentLyricIndex(lyrics, 0)).toBe(0)
    expect(findCurrentLyricIndex(lyrics, 4.9)).toBe(0)
    expect(findCurrentLyricIndex(lyrics, 5)).toBe(1)
    expect(findCurrentLyricIndex(lyrics, 99)).toBe(2)
  })

  it('进度早于第一行时返回 -1', () => {
    expect(findCurrentLyricIndex([{ time: 3, text: 'x' }], 1)).toBe(-1)
  })

  it('空歌词返回 -1', () => {
    expect(findCurrentLyricIndex([], 10)).toBe(-1)
  })

  it('非同步歌词（全部 time<=0）返回 -1，不会误高亮第一行', () => {
    expect(
      findCurrentLyricIndex(
        [
          { time: 0, text: 'a' },
          { time: 0, text: 'b' },
        ],
        10
      )
    ).toBe(-1)
  })
})
