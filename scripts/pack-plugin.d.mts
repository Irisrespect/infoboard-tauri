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
  /** 伴随程序打进包的条目数（没声明 `companion` 时为 0） */
  payloadCount: number
  /** 伴随程序的原始字节数（解压后） */
  payloadBytes: number
  /** 不致命但值得提醒的问题（如用了 invoke 却没声明 tauriCommands） */
  warnings: string[]
}

/** `packPlugin` 的选项 */
export interface PackOptions {
  /**
   * 伴随程序的源目录（CLI 的 `--companion`）。
   * manifest 里声明了 `companion` 却没给它，会直接报错 —— 不允许出空壳包。
   */
  companionSource?: string
}

/**
 * 校验插件目录并产出 zip buffer
 *
 * 会做与运行时一致的校验：id 规则、section、entry 路径、import 白名单、
 * 入口大小（2 MB）、条目数/总字节数（64 / 8 MB）、伴随程序版本一致性。
 * 任一项不合格直接抛错。
 */
export function packPlugin(pluginDir: string, options?: PackOptions): PackResult

/** 插件包条目上限（与 Rust `plugins/pack.rs` 的 MAX_ENTRIES 一致） */
export const MAX_PACKAGE_ENTRIES: number

/** 插件包解压后总字节上限（与 Rust `plugins/pack.rs` 的 MAX_TOTAL_BYTES 一致，8 MB） */
export const MAX_PACKAGE_BYTES: number

/** 插件内相对路径的安全检查（与 Rust 侧 `is_safe_rel` 一致） */
export function isSafeRelPath(rel: unknown): boolean

/** 收集伴随程序要打进包的文件（`<dir>/...`），排除 `__pycache__` / `*.pyc` / `tools/` */
export function collectCompanionPayload(sourceDir: string, decl: { dir: string }): ZipEntry[]

/** 入口文件大小上限（与 Rust `loader::MAX_ENTRY_BYTES` 一致，2 MB） */
export const MAX_ENTRY_BYTES: number

/** 运行时允许 import 的模块（与 `src/core/pluginRuntime.ts` 的 SHARED_MODULES 一致） */
export const ALLOWED_MODULES: string[]

/** 静态扫描源码里会真正生效的 import 说明符（`import type` 会被跳过） */
export function findRuntimeImports(source: string): string[]

/** 检查 import 是否都在白名单内；返回问题描述列表（空数组表示通过） */
export function checkRuntimeImports(source: string): string[]
