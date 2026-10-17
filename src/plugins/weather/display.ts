/**
 * 天气展示相关的小工具（纯函数，便于单测）
 */

/**
 * 紫外线指数文案。
 *
 * 和风 `/v7/weather/3d` 的 `daily[0].uvIndex` 在免费版 / 部分地区会缺字段，
 * 之前缺值渲染成 `--`，看起来像"样式坏了"而不是"没有数据"。
 * 这里显式区分：无值 → 「暂无」，有值 → 原样展示。
 */
export function formatUvIndex(uvIndex: string | null | undefined): string {
  const v = (uvIndex ?? '').trim()
  return v === '' ? '暂无' : v
}
