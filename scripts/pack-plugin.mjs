#!/usr/bin/env node
/**
 * 把插件目录打包成可分发的 `.ibplugin` 文件
 *
 * 用法：
 *   node scripts/pack-plugin.mjs <插件目录> [-o <输出目录>]
 *   node scripts/pack-plugin.mjs plugins/hello-world
 *   node scripts/pack-plugin.mjs plugins/        # 目录下每个插件各打一个包
 *
 * 产出 `dist-plugins/<id>-<version>.ibplugin`（默认），使用者把它拖进
 * 「设置 → 插件管理」即可安装。
 *
 * `.ibplugin` 就是一个 zip：
 *   根目录/manifest.json
 *   根目录/<manifest.entry>
 *
 * 这里自己写 zip（只用 Node 内置 zlib 的 raw deflate），不引第三方依赖 ——
 * 打包脚本是给别人 npm install 后直接跑的工具，不该为它多装一个包。
 */

import { deflateRawSync } from 'node:zlib'
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, resolve, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// ─── CRC-32（ZIP 必需）───

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[i] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

// ─── 最小 zip 写入器 ───

/**
 * @param {Array<{name: string, data: Buffer}>} entries 相对路径 → 内容
 * @returns {Buffer}
 */
export function createZip(entries) {
  const chunks = []
  const central = []
  let offset = 0

  for (const entry of entries) {
    // zip 规范要求路径用正斜杠，且不能以 / 开头
    const name = entry.name.split(sep).join('/').replace(/^\/+/, '')
    const nameBuf = Buffer.from(name, 'utf8')
    const crc = crc32(entry.data)

    // 小文件用 deflate，已压缩过的内容（如图片）deflate 后更大就退回 stored
    const deflated = deflateRawSync(entry.data, { level: 9 })
    const useDeflate = deflated.length < entry.data.length
    const payload = useDeflate ? deflated : entry.data
    const method = useDeflate ? 8 : 0

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0) // 本地文件头签名
    local.writeUInt16LE(20, 4) // 解压所需版本 2.0
    local.writeUInt16LE(0x0800, 6) // 通用标志位：文件名为 UTF-8
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10) // 修改时间
    local.writeUInt16LE(0x21, 12) // 修改日期（1980-01-01，固定值保证可复现）
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28) // 扩展字段长度

    chunks.push(local, nameBuf, payload)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0) // 中央目录头签名
    cd.writeUInt16LE(20, 4) // 创建者版本
    cd.writeUInt16LE(20, 6) // 解压所需版本
    cd.writeUInt16LE(0x0800, 8)
    cd.writeUInt16LE(method, 10)
    cd.writeUInt16LE(0, 12)
    cd.writeUInt16LE(0x21, 14)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(payload.length, 20)
    cd.writeUInt32LE(entry.data.length, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt16LE(0, 30) // 扩展字段
    cd.writeUInt16LE(0, 32) // 注释
    cd.writeUInt16LE(0, 34) // 磁盘号
    cd.writeUInt16LE(0, 36) // 内部属性
    cd.writeUInt32LE(0, 38) // 外部属性
    cd.writeUInt32LE(offset, 42) // 本地头偏移
    central.push(cd, nameBuf)

    offset += local.length + nameBuf.length + payload.length
  }

  const centralBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0) // 中央目录结束记录
  eocd.writeUInt16LE(0, 4) // 当前磁盘号
  eocd.writeUInt16LE(0, 6) // 中央目录起始磁盘号
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20) // 注释长度

  return Buffer.concat([...chunks, centralBuf, eocd])
}

// ─── 打包一个插件目录 ───

/** 与 Rust 侧 validate_plugin_id 保持一致的规则 */
export function validatePluginId(id) {
  if (typeof id !== 'string' || id.length === 0) return 'id 不能为空'
  if (id.length > 64) return 'id 过长（上限 64 字符）'
  if (!/^[A-Za-z0-9._-]+$/.test(id)) return `id 含非法字符: ${id}`
  if (id.startsWith('.') || id.endsWith('.')) return 'id 不能以点开头或结尾'
  if (id.includes('..')) return 'id 不能包含 ..'
  return null
}

/** 与 Rust 侧 loader::MAX_ENTRY_BYTES 保持一致（2 MB） */
export const MAX_ENTRY_BYTES = 2 * 1024 * 1024

/**
 * 应用侧运行时允许 import 的模块（与 `src/core/pluginRuntime.ts` 的
 * SHARED_MODULES 保持一致）。`import type` 会被擦除，所以不在此列也算合法。
 */
export const ALLOWED_MODULES = ['react', 'react/jsx-runtime', 'react-dom', '@tauri-apps/api/core']

/**
 * 静态分析入口源码里**会真正生效**的 import 说明符。
 *
 * - 跳过 `import type ...`（sucrase 转译时整体擦除，运行时不会 require）
 * - 副作用 import（`import 'x'`）也计入，它同样会被 require
 * - 这是尽力而为的正则扫描，不解析语法树；目的是在打包时提前报出最常见的问题
 */
export function findRuntimeImports(source) {
  const found = new Set()
  const re = /^[ \t]*import\s+(type\s+)?(?:[\s\S]*?\sfrom\s*)?['"]([^'"]+)['"]/gm
  let m
  while ((m = re.exec(source)) !== null) {
    if (m[1]) continue // import type：会被擦除
    found.add(m[2])
  }
  // 动态 import()（单文件插件里少见，但同样会被 require 拦下）
  const dyn = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  while ((m = dyn.exec(source)) !== null) {
    found.add(m[1])
  }
  return [...found]
}

/**
 * 检查入口里是否 import 了运行时不允许的模块。
 * @returns 问题描述列表（空数组表示没问题）
 */
export function checkRuntimeImports(source) {
  const problems = []
  for (const spec of findRuntimeImports(source)) {
    if (ALLOWED_MODULES.includes(spec)) continue
    if (spec.startsWith('.')) {
      problems.push(
        `import "${spec}"：插件必须是单文件，不支持相对路径 import（请把代码合并进入口文件）`
      )
    } else {
      problems.push(
        `import "${spec}"：不在运行时白名单里。可用：${ALLOWED_MODULES.join('、')}（import type 不受限，会被擦除）`
      )
    }
  }
  return problems
}

/**
 * 读插件目录、校验、产出 zip buffer
 * @param {string} pluginDir
 * @returns {{ id: string, version: string, buffer: Buffer, files: string[], warnings: string[] }}
 */
export function packPlugin(pluginDir) {
  const manifestPath = join(pluginDir, 'manifest.json')
  if (!existsSync(manifestPath)) {
    throw new Error(`缺少 manifest.json: ${manifestPath}`)
  }

  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (err) {
    throw new Error(`manifest.json 不是合法 JSON: ${err.message}`)
  }

  const idError = validatePluginId(manifest.id)
  if (idError) throw new Error(`manifest.id 不合法: ${idError}`)
  if (!manifest.entry || typeof manifest.entry !== 'string') {
    throw new Error('manifest.entry 缺失或不是字符串')
  }
  if (manifest.section !== 'info' && manifest.section !== 'tool') {
    throw new Error(`manifest.section 必须是 "info" 或 "tool"，当前: ${manifest.section}`)
  }
  // 与 Rust resolve_entry 一致：不许绝对路径 / ..
  const entryRel = manifest.entry.replace(/\\/g, '/')
  if (
    entryRel.startsWith('/') ||
    /^[A-Za-z]:/.test(entryRel) ||
    entryRel.split('/').includes('..')
  ) {
    throw new Error(`manifest.entry 不能是绝对路径或包含 ..: ${manifest.entry}`)
  }

  const entryPath = join(pluginDir, manifest.entry)
  if (!existsSync(entryPath) || !statSync(entryPath).isFile()) {
    throw new Error(`入口文件不存在: ${manifest.entry}`)
  }

  const entrySource = readFileSync(entryPath, 'utf8')

  // 依赖预检：应用侧会拒绝的 import 直接在这里报错，不用等装上去才发现
  const importProblems = checkRuntimeImports(entrySource)
  if (importProblems.length > 0) {
    throw new Error(`入口文件 import 检查未通过：\n  - ${importProblems.join('\n  - ')}`)
  }

  const warnings = []
  const entryBytes = Buffer.byteLength(entrySource, 'utf8')
  if (entryBytes > MAX_ENTRY_BYTES) {
    throw new Error(
      `入口文件过大（${entryBytes} 字节，上限 ${MAX_ENTRY_BYTES}）—— 应用侧会拒绝加载`
    )
  }
  if (!manifest.tauriCommands || manifest.tauriCommands.length === 0) {
    if (/\binvoke\s*(<[^>]*>)?\s*\(/.test(entrySource)) {
      warnings.push(
        '入口里用到了 invoke，但 manifest.json 没有声明 tauriCommands —— 运行时所有 invoke 都会被拒绝（fail-closed）'
      )
    }
  }

  const buffer = createZip([
    { name: 'manifest.json', data: readFileSync(manifestPath) },
    { name: entryRel, data: readFileSync(entryPath) },
  ])

  return {
    id: manifest.id,
    version: manifest.version || '0.0.0',
    buffer,
    files: ['manifest.json', entryRel],
    warnings,
  }
}

// ─── CLI ───

function isPluginDir(dir) {
  return existsSync(join(dir, 'manifest.json'))
}

function packOne(pluginDir, outDir) {
  const { id, version, buffer, files, warnings } = packPlugin(pluginDir)
  mkdirSync(outDir, { recursive: true })
  const outFile = join(outDir, `${id}-${version}.ibplugin`)
  writeFileSync(outFile, buffer)
  const kb = (buffer.length / 1024).toFixed(1)
  console.log(`✅ ${id} ${version}  →  ${outFile}  (${kb} KB)`)
  console.log(`   包含: ${files.join(', ')}`)
  for (const w of warnings ?? []) {
    console.log(`   ⚠️  ${w}`)
  }
  return outFile
}

function main() {
  const argv = process.argv.slice(2)
  let outDir = resolve('dist-plugins')
  const targets = []

  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(`用法: node scripts/pack-plugin.mjs <插件目录|包含多个插件的目录> [-o <输出目录>]

把插件目录打包成可分发的 .ibplugin 文件（其实就是一个 zip）。
使用者把 .ibplugin 拖进「设置 → 插件管理」即可安装，不需要知道插件目录在哪。

参数:
  <目录>              插件目录（含 manifest.json），或含多个插件的父目录
  -o, --out <目录>    输出目录，默认 dist-plugins
  -h, --help          显示本帮助

示例:
  node scripts/pack-plugin.mjs plugins/hello-world
  node scripts/pack-plugin.mjs plugins -o build

打包前会做与运行时一致的校验（id 规则、section、entry 路径、import 白名单、
入口大小），不合格直接报错，不必等装上去才发现。`)
    return
  }

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-o' || a === '--out') {
      const next = argv[++i]
      if (!next) {
        console.error(`❌ ${a} 后面需要跟输出目录`)
        process.exit(1)
      }
      outDir = resolve(next)
    } else if (a.startsWith('-')) {
      console.error(`❌ 未知参数: ${a}`)
      process.exit(1)
    } else {
      targets.push(a)
    }
  }

  if (targets.length === 0) {
    console.error(
      '用法: node scripts/pack-plugin.mjs <插件目录|包含多个插件的目录> [-o <输出目录>]'
    )
    process.exit(1)
  }

  let count = 0
  for (const target of targets) {
    const dir = resolve(target)
    if (!existsSync(dir)) {
      console.error(`❌ 目录不存在: ${dir}`)
      process.exitCode = 1
      continue
    }
    // 目标是单个插件？
    if (isPluginDir(dir)) {
      packOne(dir, outDir)
      count++
      continue
    }
    // 否则当作"包含多个插件的父目录"
    const subs = readdirSync(dir).filter((n) => {
      const p = join(dir, n)
      return statSync(p).isDirectory() && !n.startsWith('.') && isPluginDir(p)
    })
    if (subs.length === 0) {
      console.error(`❌ ${dir} 下没有找到插件（需要含 manifest.json 的子目录）`)
      process.exitCode = 1
      continue
    }
    for (const sub of subs) {
      packOne(join(dir, sub), outDir)
      count++
    }
  }

  console.log(`\n共打包 ${count} 个插件 → ${relative(process.cwd(), outDir) || '.'}`)
}

// 仅在直接执行时跑 CLI（被 import 时不跑，便于测试）
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  main()
}
