/**
 * `scripts/check-version.mjs` 的类型声明
 *
 * 与 `pack-plugin.d.mts` 同理：脚本是纯 JS（要能 `node scripts/check-version.mjs` 直接跑），
 * 但测试 import 它的纯函数做校验。这里手写声明，避免打开 `allowJs`。
 */

/** 三处版本声明 */
export interface Versions {
  /** `src-tauri/tauri.conf.json` 的 version（单一来源，决定安装包文件名） */
  conf: string
  /** `package.json` 的 version */
  pkg: string
  /** `Cargo.toml` [package] 段的 version；解析不到时为 null */
  cargo: string | null
}

/** 读取仓库三处版本号（默认以仓库根为基准） */
export function readVersions(root?: string): Versions

/** 是否为合法的 x.y.z（允许 -prerelease 后缀） */
export function isSemver(v: unknown): boolean

/** 比较三处是否一致；返回不一致的描述列表（空数组表示一致） */
export function compareVersions(v: Versions): string[]

/** 以给定版本改写 package.json 与 Cargo.toml */
export function writeVersions(version: string, root?: string): void
