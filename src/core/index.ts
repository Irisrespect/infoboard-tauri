/**
 * 核心模块导出
 *
 * 统一导出所有核心模块，方便其他地方使用
 */

// 类型定义
export type {
  PluginManifest,
  PluginComponentProps,
  InfoBoardPlugin,
  ExternalPluginMeta,
} from './types'

// 插件注册表
export { PluginRegistry, pluginRegistry } from './PluginRegistry'

// 插件宿主
export {
  PluginHost,
  initPluginSystem,
  reloadPluginSystem,
  usePluginSystem,
  usePlugins,
} from './PluginHost'

// 插件加载器
export { PluginLoader, pluginLoader } from './PluginLoader'
