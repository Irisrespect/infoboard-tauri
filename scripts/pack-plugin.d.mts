/**
 * `scripts/pack-plugin.mjs` 的类型声明
 *
 * 打包脚本是纯 JS（要能被 `node scripts/pack-plugin.mjs` 直接跑，不引依赖），
 * 但测试 import 它做往返校验。这里手写声明，避免打开 `allowJs` 把整个 scripts/
 * 都拉进类型检查。
 */

/** zip 条目：相对路径 + 内容 */
export interface ZipEntry {
  name: string
  data: Buffer
}

/**
 * 用最小 zip 写入器打包（只用 Node 内置 zlib 的 raw deflate）
 * @param entries 相对路径 → 内容
 */
export function createZip(entries: ZipEntry[]): Buffer

/**
 * 校验插件 id（规则与 Rust 侧 `pack::validate_plugin_id` 保持一致）
 * @returns 合法时返回 `null`，否则返回错误描述
 */
export function validatePluginId(id: unknown): string | null

/** 打包结果 */
export interface PackResult {
  id: string
  version: string
  buffer: Buffer
  /** 包内包含的文件（相对路径） */
  files: string[]
}

/**
 * 校验插件目录并产出 zip buffer
 * @param pluginDir 含 manifest.json 的插件目录
 */
export function packPlugin(pluginDir: string): PackResult
