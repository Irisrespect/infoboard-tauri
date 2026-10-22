import type { InfoBoardPlugin } from '../core/types'
import { weatherPlugin } from './weather'
import { todoPlugin } from './todo'
import { dynamicIslandPlugin } from './dynamic-island'
import { settingsPlugin } from './settings'
import { screenshotPlugin } from './screenshot'

/**
 * 内置插件列表
 *
 * 注意：`translate` 已经**不再**是内置插件 —— 翻译重建成了外部插件包
 * （`plugins/translate/`，可独立分发/热装）。这里把它的 id 让出来，
 * 否则外部插件注册时会因为 id 重复被跳过，界面上会只剩一个旧卡片。
 *
 * 设置面板里的「小牛翻译 API」配置区仍在，传输层见 `core/niutrans-bridge.ts`：
 * 它和外部插件写的是同一份存储。
 */
export const plugins: InfoBoardPlugin[] = [
  dynamicIslandPlugin,
  weatherPlugin,
  todoPlugin,
  settingsPlugin,
  screenshotPlugin,
]
