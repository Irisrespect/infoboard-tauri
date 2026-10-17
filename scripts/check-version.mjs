#!/usr/bin/env node
/**
 * 版本号单一来源校验
 *
 * 三处声明必须一致，否则会实际出问题：
 * - `src-tauri/tauri.conf.json` → 决定**安装包文件名**（InfoBoard_x.y.z_x64-setup.exe）
 *   以及"程序和功能"里显示的版本
 * - `Cargo.toml` → 决定二进制内嵌的 FileVersion / ProductVersion（NSIS 读它做升级判断）
 * - `package.json` → 前端生态的版本
 *
 * 之前三处都停在 0.1.0，而 GitHub 上已经有 v0.4.0 —— 于是"文件名写着 0.1.0、
 * 实际是新版本"这种对不上的情况没人发现。这个脚本让漂移在提交时就被拦住。
 *
 * 用法：
 *   node scripts/check-version.mjs          # 校验（不一致则非 0 退出）
 *   node scripts/check-version.mjs --write  # 以 tauri.conf.json 为准，改写另外两处
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(import.meta.url), '../..')

const CONF = 'src-tauri/tauri.conf.json'
const CARGO = 'src-tauri/Cargo.toml'
const PKG = 'package.json'

/** 读取三处版本号 */
export function readVersions(root = ROOT) {
  const conf = JSON.parse(readFileSync(resolve(root, CONF), 'utf8'))
  const pkg = JSON.parse(readFileSync(resolve(root, PKG), 'utf8'))
  const cargoText = readFileSync(resolve(root, CARGO), 'utf8')
  // 只取 [package] 段里的第一个 version = "..."（依赖版本用的是 version = "2" 形式且带缩进）
  const m = cargoText.match(/^version\s*=\s*"([^"]+)"/m)
  return {
    conf: conf.version,
    pkg: pkg.version,
    cargo: m ? m[1] : null,
  }
}

/** 语义化版本基本校验 */
export function isSemver(v) {
  return typeof v === 'string' && /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v)
}

/** 比较三处是否一致，返回不一致的描述列表 */
export function compareVersions(v) {
  const problems = []
  if (!isSemver(v.conf)) problems.push(`${CONF} 的版本不是合法的 x.y.z：${v.conf}`)
  if (v.pkg !== v.conf) problems.push(`${PKG} (${v.pkg}) 与 ${CONF} (${v.conf}) 不一致`)
  if (v.cargo === null) problems.push(`${CARGO} 里找不到版本号`)
  else if (v.cargo !== v.conf) problems.push(`${CARGO} (${v.cargo}) 与 ${CONF} (${v.conf}) 不一致`)
  return problems
}

/** 以 tauri.conf.json 为准改写另外两处（保持原格式风格） */
export function writeVersions(version, root = ROOT) {
  const pkgPath = resolve(root, PKG)
  const pkgText = readFileSync(pkgPath, 'utf8')
  const pkgIndent = /\t/.test(pkgText) ? '\t' : '  '
  const pkg = JSON.parse(pkgText)
  pkg.version = version
  writeFileSync(pkgPath, JSON.stringify(pkg, null, pkgIndent) + '\n')

  const cargoPath = resolve(root, CARGO)
  const cargoText = readFileSync(cargoPath, 'utf8')
  // 只替换 [package] 段顶部的裸 version = "x.y.z"
  const next = cargoText.replace(/^version\s*=\s*"[^"]+"/m, `version = "${version}"`)
  if (next === cargoText) throw new Error(`${CARGO} 里没有可替换的 version 行`)
  writeFileSync(cargoPath, next)
}

// ─── CLI ───

function main() {
  const write = process.argv.includes('--write')
  const v = readVersions()

  if (write) {
    if (!isSemver(v.conf)) {
      console.error(`❌ ${CONF} 的版本不合法：${v.conf}`)
      process.exit(1)
    }
    writeVersions(v.conf)
    console.log(`✅ 已把 ${PKG} 与 ${CARGO} 同步为 ${v.conf}（来源：${CONF}）`)
    return
  }

  const problems = compareVersions(v)
  if (problems.length > 0) {
    console.error('❌ 版本号不一致：')
    for (const p of problems) console.error(`   - ${p}`)
    console.error(`\n以 ${CONF} 为准修正：node scripts/check-version.mjs --write`)
    process.exit(1)
  }
  console.log(`✅ 版本号一致：${v.conf}（${CONF} / ${PKG} / ${CARGO}）`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
