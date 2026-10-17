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
  /** 不致命但值得提醒的问题（如用了 invoke 却没声明 tauriCommands） */
  warnings: string[]
}

/**
 * 校验插件目录并产出 zip buffer
 *
 * 会做与运行时一致的校验：id 规则、section、entry 路径、import 白名单、
 * 入口大小（2 MB）。任一项不合格直接抛错。
 */
export function packPlugin(pluginDir: string): PackResult

/** 入口文件大小上限（与 Rust `loader::MAX_ENTRY_BYTES` 一致，2 MB） */
export const MAX_ENTRY_BYTES: number

/** 运行时允许 import 的模块（与 `src/core/pluginRuntime.ts` 的 SHARED_MODULES 一致） */
export const ALLOWED_MODULES: string[]

/** 静态扫描源码里会真正生效的 import 说明符（`import type` 会被跳过） */
export function findRuntimeImports(source: string): string[]

/** 检查 import 是否都在白名单内；返回问题描述列表（空数组表示通过） */
export function checkRuntimeImports(source: string): string[]
