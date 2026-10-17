import { describe, it, expect } from 'vitest'
import { readVersions, compareVersions, isSemver } from '../../scripts/check-version.mjs'

/**
 * 版本号漂移的回归测试。
 *
 * 背景：三处版本声明曾长期停在 0.1.0，而 GitHub 上已经发到 v0.4.0 ——
 * 于是安装包文件名（由 tauri.conf.json 决定）与实际版本对不上，没人发现。
 */
describe('版本号单一来源', () => {
  it('仓库当前三处版本一致', () => {
    const v = readVersions()
    expect(compareVersions(v)).toEqual([])
  })

  it('版本号是合法的 x.y.z', () => {
    expect(isSemver(readVersions().conf)).toBe(true)
  })

  it('Cargo.toml 的版本能被正确解析（不会被依赖版本干扰）', () => {
    const v = readVersions()
    // Cargo.toml 里依赖写成 `tauri = { version = "2", ... }`（带缩进/花括号），
    // 解析必须只取 [package] 段的裸 version 行
    expect(v.cargo).toMatch(/^\d+\.\d+\.\d+/)
    expect(v.cargo).toBe(v.conf)
  })

  it('检出 package.json 漂移', () => {
    const problems = compareVersions({ conf: '1.0.0', pkg: '0.9.0', cargo: '1.0.0' })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('package.json')
  })

  it('检出 Cargo.toml 漂移', () => {
    const problems = compareVersions({ conf: '1.0.0', pkg: '1.0.0', cargo: '1.0.1' })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('Cargo.toml')
  })

  it('检出 Cargo.toml 缺版本号', () => {
    const problems = compareVersions({ conf: '1.0.0', pkg: '1.0.0', cargo: null })
    expect(problems.some((p) => p.includes('找不到版本号'))).toBe(true)
  })

  it('检出非法版本格式', () => {
    const problems = compareVersions({ conf: 'v1.0', pkg: 'v1.0', cargo: 'v1.0' })
    expect(problems.some((p) => p.includes('不是合法的'))).toBe(true)
  })

  it('三处一致时没有问题', () => {
    expect(compareVersions({ conf: '2.3.4', pkg: '2.3.4', cargo: '2.3.4' })).toEqual([])
  })

  it('接受带预发布后缀的版本', () => {
    expect(isSemver('1.0.0-beta.1')).toBe(true)
    expect(
      compareVersions({ conf: '1.0.0-beta.1', pkg: '1.0.0-beta.1', cargo: '1.0.0-beta.1' })
    ).toEqual([])
  })
})
