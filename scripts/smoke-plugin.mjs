/**
 * 离线冒烟：用应用同款 sucrase 把外部插件转译并执行一遍，验证它**真的能加载**。
 *
 * 补的是 `tsc` 与打包脚本都覆盖不到的那一段：
 * - 打包脚本只做静态 import 白名单检查，不执行代码
 * - `tsc` 不跑 sucrase，也不会发现"转译后才炸"的语法/顶层副作用问题
 *
 * 覆盖：转译 → 受控 require → 求值 → 校验导出形状（manifest / Component）。
 * 不渲染组件，所以不需要真实 DOM。
 *
 * 用法：
 *   node scripts/smoke-plugin.mjs                 # 默认 plugins/translate
 *   node scripts/smoke-plugin.mjs plugins/netdisk
 */
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const { transform } = require('sucrase')
const React = require('react')
const ReactJsx = require('react/jsx-runtime')
const ReactDom = require('react-dom')

const dir = (process.argv[2] ?? 'plugins/translate').replace(/[\\/]+$/, '')
const manifestPath = join(dir, 'manifest.json')
if (!existsSync(manifestPath)) {
  console.error(`❌ 找不到 ${manifestPath}`)
  process.exit(1)
}

const manifestJson = JSON.parse(readFileSync(manifestPath, 'utf8'))
const entry = join(dir, manifestJson.entry ?? 'index.tsx')
const src = readFileSync(entry, 'utf8')

let code
try {
  code = transform(src, {
    transforms: ['typescript', 'jsx', 'imports'],
    jsxRuntime: 'automatic',
    filePath: entry,
    production: true,
  }).code
} catch (e) {
  console.error(`❌ 转译失败: ${e.message}`)
  process.exit(1)
}

const modules = {
  react: React,
  'react/jsx-runtime': ReactJsx,
  'react-dom': ReactDom,
  '@tauri-apps/api/core': { invoke: async () => null },
}

const requireShared = (id) => {
  if (!Object.prototype.hasOwnProperty.call(modules, id)) {
    throw new Error(`import 了不支持的模块: ${id}（白名单：${Object.keys(modules).join(', ')}）`)
  }
  return modules[id]
}

const mod = { exports: {} }
try {
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', code)(mod, mod.exports, requireShared)
} catch (e) {
  console.error(`❌ 执行失败（顶层副作用不该有）: ${e.message}`)
  process.exit(1)
}

const plugin = mod.exports.default ?? mod.exports.plugin
const problems = []
if (!plugin) problems.push('没有 default / plugin 导出')
if (plugin && plugin.manifest?.id !== manifestJson.id) {
  problems.push(
    `源码里的 manifest.id (${plugin.manifest?.id}) 与 manifest.json (${manifestJson.id}) 不一致`
  )
}
if (plugin && typeof plugin.Component !== 'function') problems.push('Component 不是函数')
if (plugin && !plugin.manifest?.icon) problems.push('manifest.icon 为空')
if (plugin && plugin.manifest?.section !== manifestJson.section) {
  problems.push('源码与 manifest.json 的 section 不一致')
}

console.log(`插件: ${manifestJson.id} v${manifestJson.version}`)
console.log(`转译后代码长度: ${code.length}`)
console.log(`导出: ${Object.keys(mod.exports).join(', ') || '(无)'}`)
console.log(`Component: ${typeof plugin?.Component} ${plugin?.Component?.name ?? ''}`)

if (problems.length) {
  console.error('❌ 冒烟失败:\n  - ' + problems.join('\n  - '))
  process.exit(1)
}
console.log('✅ 可转译、可求值，导出形状合法')
