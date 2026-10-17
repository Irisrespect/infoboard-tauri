/**
 * B 站封面/UP 主补全缓存策略（纯函数，便于单测）
 *
 * 原先 `useMediaControl` 里的 `bilibiliCache` 只写不删：
 * 每换一首歌就多一条 title → data，且负缓存（无结果/失败）也照样写入，
 * 长时间挂着会一直涨。这里给出统一的"该淘汰哪些 key"的判定。
 */

/** 缓存条目上限；超过后淘汰最旧/最早过期的条目 */
export const MAX_BILI_CACHE_ENTRIES = 100

export interface CacheEntry {
  /** 过期时间戳（ms） */
  expires: number
}

/**
 * 计算写入一条新记录前需要淘汰的 key。
 *
 * 规则：
 * 1. 已过期的条目优先淘汰（它们本来也没用了）
 * 2. 仍然超限时，按 `expires` 升序淘汰最早的，直到容量让出一个位置
 *
 * @param entries  当前缓存的所有条目（key → entry）
 * @param now      当前时间戳（ms）
 * @param max      容量上限
 * @returns 需要删除的 key 列表（不含即将写入的那个 key；为空表示无需淘汰）
 */
export function selectEvictions<K extends string>(
  entries: Iterable<[K, CacheEntry]>,
  now: number,
  max: number = MAX_BILI_CACHE_ENTRIES
): K[] {
  const list = Array.from(entries)
  if (list.length < max) return []

  const evictions: K[] = []

  // 1) 先清过期的（不占额外容量）
  const alive: Array<[K, CacheEntry]> = []
  for (const [key, entry] of list) {
    if (entry.expires <= now) evictions.push(key)
    else alive.push([key, entry])
  }

  // 2) 写入后会变成 alive.length + 1 条；超出上限就继续淘汰最早的
  let overflow = alive.length + 1 - max
  if (overflow > 0) {
    alive.sort((a, b) => a[1].expires - b[1].expires)
    for (const [key] of alive) {
      if (overflow <= 0) break
      evictions.push(key)
      overflow -= 1
    }
  }

  return evictions
}
