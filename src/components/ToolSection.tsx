/**
 * 工具区容器
 *
 * 负责：
 * 1. 图标网格布局（4列）
 * 2. 点击图标展开对应插件面板
 * 3. 管理展开状态
 */

import { useState, useCallback } from 'react'
import { usePlugins } from '../core/PluginHost'
import { ToolExpandPanel } from './ToolExpandPanel'
import { invoke } from '@tauri-apps/api/core'
import type { InfoBoardPlugin, PluginManifest } from '../core/types'

/** Lucide SVG 图标注册表（常用工具图标） */
export const SVG_ICONS: Record<string, React.ReactNode> = {
  camera: (
    <>
      <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
      <circle cx="12" cy="13" r="3" />
    </>
  ),
  settings: (
    <>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  languages: (
    <>
      <path d="m5 8 6 6" />
      <path d="m4 14 6-6 2-3" />
      <path d="M2 5h12" />
      <path d="M7 2h1" />
      <path d="m22 22-5-10-5 10" />
      <path d="M14 18h6" />
    </>
  ),
  // 网盘下载：云 + 向下箭头
  'cloud-download': (
    <>
      <path d="M12 13v8l-4-4" />
      <path d="m12 21 4-4" />
      <path d="M4.393 15.269A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.436 8.284" />
    </>
  ),
  // API 测活：一条脉冲折线 —— "测活 / 测速"最直观的意象
  activity: (
    <path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2" />
  ),
}

/**
 * 判断图标字符串是否为 emoji（非 SVG 图标名）。
 *
 * 原实现是 `str.length <= 2 && !/^[a-z]/`，两个方向都会判错：
 * - 带变体选择符 / 肤色修饰符 / ZWJ 序列的 emoji 长度是 4~7 个 UTF-16 码元
 *   （如 "👋🏽"、"🏳️‍🌈"），会被判成**不是** emoji → 落到"未知图标"分支显示小号灰字
 * - 两个汉字（如 "设置"）长度是 2 且不以小写字母开头 → 被判成 emoji
 *
 * 改为按 Unicode 属性判断。注意国旗是**两个** Regional_Indicator 组成，
 * 且它们不属于 Extended_Pictographic，必须单独匹配一对。
 */
const EMOJI_TAIL =
  /(?:\uFE0F|\p{Emoji_Modifier}|\u200D(?:\p{Extended_Pictographic}|\p{Regional_Indicator}))*/u
const EMOJI_REGEX = new RegExp(
  `^(?:\\p{Regional_Indicator}{2}|\\p{Extended_Pictographic}${EMOJI_TAIL.source})$`,
  'u'
)

export function isEmoji(str: string): boolean {
  const s = str.trim()
  if (!s) return false
  return EMOJI_REGEX.test(s)
}

/**
 * 工具区容器组件
 *
 * @example
 * ```tsx
 * <ToolSection />
 * ```
 */
export function ToolSection() {
  const toolPlugins = usePlugins('tool')
  const [expandedPluginId, setExpandedPluginId] = useState<string | null>(null)

  /**
   * 切换插件展开/折叠
   *
   * 有两个插件点图标是"直接动作"而不是"展开面板"：
   * - screenshot：直接开始截图
   * - netdisk：直接拉起独立的「网盘下载器」软件
   *
   * 网盘下载不给中间面板：它本来就是个独立软件，多一步"先开面板再点按钮"没有意义，
   * 而且会让人误以为下载跑在面板里 —— 面板一关就断了。
   */
  const togglePlugin = useCallback((pluginId: string) => {
    if (pluginId === 'screenshot') {
      invoke('screenshot_start').catch((e) => console.error('[截图] 启动失败:', e))
      return
    }
    if (pluginId === 'netdisk') {
      invoke<string>('netdisk_app_launch').catch((e) => {
        console.error('[网盘下载] 启动失败:', e)
        // 失败必须让用户看见：最常见的原因是本机没装 Python，
        // 只在控制台打印等于什么都没说。
        // 注意 `plugin:dialog|message` 的参数是**平铺**的（message/title/kind），
        // 不是 open 那样的 { options } —— 传错了会静默失败。
        invoke('plugin:dialog|message', {
          message: String(e),
          title: '没能打开网盘下载器',
          kind: 'error',
        }).catch((err) => console.error('[网盘下载] 连错误提示都没弹出来:', err))
      })
      return
    }
    if (pluginId === 'api-probe') {
      // 测活工具不随包分发，第一次要先指定一次 api_probe.py 的位置。
      // 已经配好 → 直接开；没配好 → 展开面板去配（面板里会说明原因）。
      invoke<string>('apiprobe_app_launch').catch(() => setExpandedPluginId('api-probe'))
      return
    }
    setExpandedPluginId((prev) => (prev === pluginId ? null : pluginId))
  }, [])

  /**
   * 关闭展开面板
   */
  const handleClose = useCallback(() => {
    setExpandedPluginId(null)
  }, [])

  // 获取当前展开的插件
  const expandedPlugin = expandedPluginId
    ? toolPlugins.find((p) => p.manifest.id === expandedPluginId)
    : null

  return (
    <section className="flex flex-col gap-3">
      {/* 分隔线 + 标签 */}
      <SectionLabel />

      {/* 工具图标网格 */}
      <div className="grid grid-cols-4 gap-2.5">
        {toolPlugins.length === 0 ? (
          <EmptyGrid />
        ) : (
          toolPlugins.map((plugin) => (
            <ToolIcon
              key={plugin.manifest.id}
              manifest={plugin.manifest}
              isActive={expandedPluginId === plugin.manifest.id}
              onClick={() => togglePlugin(plugin.manifest.id)}
            />
          ))
        )}
      </div>

      {/* 展开面板 */}
      {expandedPlugin && <ToolExpandPanel plugin={expandedPlugin} onClose={handleClose} />}
    </section>
  )
}

/**
 * 区域标签（带分隔线）
 */
function SectionLabel() {
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-px bg-border-subtle" />
      <span className="text-[11px] font-semibold text-text-muted tracking-widest uppercase">
        工具区
      </span>
      <div className="flex-1 h-px bg-border-subtle" />
    </div>
  )
}

/**
 * 工具图标属性
 */
interface ToolIconProps {
  manifest: PluginManifest
  isActive: boolean
  onClick: () => void
}

/**
 * 工具图标组件
 *
 * 显示单个工具的图标和名称
 */
export function ToolIcon({ manifest, isActive, onClick }: ToolIconProps) {
  /**
   * 激活态颜色必须指向**真实存在**的 CSS 变量。
   *
   * 这里原来写的是 `--color-primary`，而工程里从来没定义过它（CSS 里只有 `--accent`，
   * 运行时也没人 setProperty）。`color` 是继承属性，写错了顶多不变色；
   * 但 `stroke` 不是 —— var() 引用未定义变量会让声明在"计算值阶段"失效，
   * `stroke` 回落到初始值 `none`：**点中的插件图标会整个消失**
   * （截图 / 设置 / 翻译三个具名图标插件都在这个分支里）。
   *
   * 直接用 `var(--accent)` 而不是 useThemeColors()：主题切换时由浏览器重算，
   * 不需要 React 重渲染，也不给这个组件引入对 DOM 的模块级依赖。
   */
  const activeColor = 'var(--accent)'
  // 没给 color 时退回 currentColor：和 emoji 图标"继承文字颜色"的行为一致。
  // 不这样兜底的话，具名图标会因为 stroke 缺失而整个不可见。
  const iconColor = isActive ? activeColor : manifest.color || 'currentColor'

  const iconClassName = [
    'h-[68px] rounded-card glass-card',
    'flex flex-col items-center justify-center gap-1.5',
    'cursor-pointer transition-all duration-200',
    'hover:shadow-card-hover',
    isActive ? 'ring-2 ring-accent shadow-card-hover' : 'hover:bg-bg-surface-hover',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <button
      className={iconClassName}
      onClick={onClick}
      title={manifest.name}
      data-plugin-id={manifest.id}
      data-active={isActive}
    >
      {/* 图标 */}
      {isEmoji(manifest.icon) ? (
        <span className="text-xl" style={{ color: iconColor }}>
          {manifest.icon}
        </span>
      ) : SVG_ICONS[manifest.icon] ? (
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          style={{ stroke: iconColor }}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {SVG_ICONS[manifest.icon]}
        </svg>
      ) : (
        <span className="text-xl text-text-muted">{manifest.icon}</span>
      )}

      {/* 名称 */}
      <span
        className="text-xs font-medium"
        style={{
          color: isActive ? activeColor : 'var(--text-secondary)',
        }}
      >
        {manifest.name}
      </span>

      {/* 角标 */}
      {manifest.badge !== undefined && (
        <span className="absolute -top-1 -right-1 w-4 h-4 flex items-center justify-center text-[10px] font-semibold rounded-full bg-red-500 text-white">
          {manifest.badge}
        </span>
      )}
    </button>
  )
}

/**
 * 空状态网格
 */
function EmptyGrid() {
  const emptyItems = ['笔记', '搜索', '剪贴板', '日历', '通讯', '数据', '设置', '更多']

  return (
    <>
      {emptyItems.map((name) => (
        <div
          key={name}
          className="h-[68px] rounded-card bg-bg-surface border border-border-subtle flex flex-col items-center justify-center gap-1.5 opacity-50"
        >
          <span className="text-text-muted text-xs">{name}</span>
        </div>
      ))}
    </>
  )
}
