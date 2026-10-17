import { describe, it, expect } from 'vitest'
import { createZip, packPlugin, validatePluginId } from '../../scripts/pack-plugin.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { inflateRawSync } from 'node:zlib'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/** 最小 zip 读取器：只解析中央目录，够用来断言打包结果 */
export function readZipEntries(buffer: Buffer): Array<{ name: string; data: Buffer }> {
  // 从尾部找 EOCD（0x06054b50）
  let eocd = -1
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('不是有效的 zip：找不到 EOCD')

  const count = buffer.readUInt16LE(eocd + 10)
  let p = buffer.readUInt32LE(eocd + 16)
  const entries: Array<{ name: string; data: Buffer }> = []

  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(p) !== 0x02014b50) throw new Error('中央目录头签名错误')
    const method = buffer.readUInt16LE(p + 10)
    const compSize = buffer.readUInt32LE(p + 20)
    const nameLen = buffer.readUInt16LE(p + 28)
    const extraLen = buffer.readUInt16LE(p + 30)
    const commentLen = buffer.readUInt16LE(p + 32)
    const localOffset = buffer.readUInt32LE(p + 42)
    const name = buffer.subarray(p + 46, p + 46 + nameLen).toString('utf8')

    // 本地头：30 字节 + 文件名 + 扩展字段，之后才是数据
    const lNameLen = buffer.readUInt16LE(localOffset + 26)
    const lExtraLen = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + lNameLen + lExtraLen
    const raw = buffer.subarray(dataStart, dataStart + compSize)

    entries.push({
      name,
      // 打包脚本对"压缩后更大"的内容会退回 stored，所以两种都要能解
      data: method === 0 ? raw : inflateRawSync(raw),
    })

    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

function makePluginDir(files: Record<string, string>, manifest?: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), 'pack-test-'))
  const m = manifest ?? {
    id: 'test-plugin',
    name: '测试插件',
    version: '1.2.3',
    section: 'info',
    icon: '🔧',
    entry: 'index.tsx',
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m, null, 2))
  for (const [name, content] of Object.entries(files)) {
    const full = join(dir, name)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content)
  }
  return dir
}

describe('createZip', () => {
  it('产出合法的 zip（EOCD + 中央目录条目可读回）', () => {
    const zip = createZip([
      { name: 'manifest.json', data: Buffer.from('{"a":1}') },
      { name: 'index.tsx', data: Buffer.from('export default 1') },
    ])
    const entries = readZipEntries(zip)
    expect(entries.map((e) => e.name)).toEqual(['manifest.json', 'index.tsx'])
    expect(entries[0].data.toString()).toBe('{"a":1}')
    expect(entries[1].data.toString()).toBe('export default 1')
  })

  it('内容能压缩时确实用了 deflate（写得比原文小）', () => {
    const big = 'a'.repeat(10000)
    const zip = createZip([{ name: 'big.txt', data: Buffer.from(big) }])
    expect(zip.length).toBeLessThan(big.length / 2)
    expect(readZipEntries(zip)[0].data.toString()).toBe(big)
  })

  it('路径统一用正斜杠，且不带前导斜杠', () => {
    const zip = createZip([{ name: '\\sub\\index.tsx', data: Buffer.from('x') }])
    expect(readZipEntries(zip)[0].name).toBe('sub/index.tsx')
  })

  it('中文内容按 UTF-8 往返', () => {
    const text = '你好，世界 🌏'
    const zip = createZip([{ name: 'a.txt', data: Buffer.from(text, 'utf8') }])
    expect(readZipEntries(zip)[0].data.toString('utf8')).toBe(text)
  })
})

describe('validatePluginId（与 Rust 侧 validate_plugin_id 规则一致）', () => {
  it('接受常规 id', () => {
    for (const id of ['hello-world', 'my_plugin', 'plug.v2', 'a', 'A1']) {
      expect(validatePluginId(id), id).toBeNull()
    }
  })

  it('拒绝路径语义与非法字符', () => {
    for (const id of [
      '',
      '..',
      '.',
      '../evil',
      'a/b',
      'a\\b',
      '.hidden',
      'trail.',
      '中文',
      'a'.repeat(65),
    ]) {
      expect(validatePluginId(id), id).not.toBeNull()
    }
  })
})

describe('packPlugin', () => {
  it('产出含 manifest.json 与入口文件的包', () => {
    const dir = makePluginDir({ 'index.tsx': 'export default 1' })
    try {
      const { id, version, files } = packPlugin(dir)
      expect(id).toBe('test-plugin')
      expect(version).toBe('1.2.3')
      expect(files).toEqual(['manifest.json', 'index.tsx'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('包内只有这两个文件，且内容与磁盘一致', () => {
    const dir = makePluginDir({ 'index.tsx': 'export default 42' })
    try {
      const entries = readZipEntries(packPlugin(dir).buffer)
      expect(entries).toHaveLength(2)
      expect(entries.map((e) => e.name).sort()).toEqual(['index.tsx', 'manifest.json'])
      expect(entries.find((e) => e.name === 'index.tsx')!.data.toString()).toBe('export default 42')
      const m = JSON.parse(entries.find((e) => e.name === 'manifest.json')!.data.toString())
      expect(m.id).toBe('test-plugin')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('没有 manifest.json 时报错', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pack-test-'))
    try {
      writeFileSync(join(dir, 'index.tsx'), 'x')
      expect(() => packPlugin(dir)).toThrow(/manifest\.json/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('manifest 不是合法 JSON 时报错', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pack-test-'))
    try {
      writeFileSync(join(dir, 'manifest.json'), '{ not json')
      writeFileSync(join(dir, 'index.tsx'), 'x')
      expect(() => packPlugin(dir)).toThrow(/JSON/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('入口文件缺失时报错', () => {
    const dir = makePluginDir({})
    try {
      expect(() => packPlugin(dir)).toThrow(/入口文件不存在/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('section 非法时报错', () => {
    const dir = makePluginDir(
      { 'index.tsx': 'x' },
      {
        id: 'p',
        name: 'n',
        version: '1',
        section: 'evil',
        icon: 'x',
        entry: 'index.tsx',
      }
    )
    try {
      expect(() => packPlugin(dir)).toThrow(/section/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('entry 指向绝对路径或含 .. 时报错（与 Rust resolve_entry 一致）', () => {
    for (const entry of ['../evil.tsx', 'C:/Windows/system.ini', '/etc/passwd']) {
      const dir = makePluginDir(
        { 'index.tsx': 'x' },
        {
          id: 'p',
          name: 'n',
          version: '1',
          section: 'info',
          icon: 'x',
          entry,
        }
      )
      try {
        expect(() => packPlugin(dir), entry).toThrow()
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  })
})

/**
 * 格式契约：打包脚本产出的包必须能被应用读取。
 * 由 Rust 侧 `installs_real_package_produced_by_pack_script` 反向校验
 * （它 include_bytes! 读同一个文件并真的安装一遍）。
 */
describe('提交到仓库的示例包', () => {
  const pkgPath = join(process.cwd(), 'dist-plugins', 'hello-world-1.0.0.ibplugin')

  it('存在且是合法 zip，含 manifest.json 与入口', () => {
    const buf = readFileSync(pkgPath)
    const entries = readZipEntries(buf)
    const names = entries.map((e) => e.name)
    expect(names).toContain('manifest.json')
    expect(names).toContain('index.tsx')

    const manifest = JSON.parse(entries.find((e) => e.name === 'manifest.json')!.data.toString())
    expect(manifest.id).toBe('hello-world')
    expect(manifest.section).toBe('info')
  })

  it('内容与仓库里的示例源码一致（重新打包应该得到同样的文件）', () => {
    const repoDir = join(process.cwd(), 'plugins', 'hello-world')
    const { buffer } = packPlugin(repoDir)
    const committed = readFileSync(pkgPath)

    const a = readZipEntries(buffer).sort((x, y) => x.name.localeCompare(y.name))
    const b = readZipEntries(committed).sort((x, y) => x.name.localeCompare(y.name))
    expect(a.map((e) => e.name)).toEqual(b.map((e) => e.name))
    for (let i = 0; i < a.length; i++) {
      // 时间戳固定，内容一致即视为一致（压缩字节可能因 zlib 版本不同而略有差异）
      expect(a[i].data.equals(b[i].data), a[i].name).toBe(true)
    }
  })
})
