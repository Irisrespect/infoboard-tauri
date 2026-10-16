import type { InfoBoardPlugin } from '../core/types'
import { weatherPlugin } from './weather'
import { todoPlugin } from './todo'
import { dynamicIslandPlugin } from './dynamic-island'
import { settingsPlugin } from './settings'
import { screenshotPlugin } from './screenshot'
import { translatePlugin } from './translate'

export const plugins: InfoBoardPlugin[] = [
  dynamicIslandPlugin,
  weatherPlugin,
  todoPlugin,
  settingsPlugin,
  screenshotPlugin,
  translatePlugin,
]
