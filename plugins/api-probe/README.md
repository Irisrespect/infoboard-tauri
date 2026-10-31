# API 测活（InfoBoard 插件）

工具区一个图标，点开独立的 **[API 中转站测活工具](https://github.com/Irisrespect/api-probe)** ——
多站点、每站多 Key、模型与协议探测、真实生成测试、批量巡检，
一键接入 Claude Code、Codex（CLI + 桌面版）和 Grok Build。

```bash
node scripts/pack-plugin.mjs plugins/api-probe
# → dist-plugins/api-probe-1.1.0.ibplugin
```

## 1.1.0：把面板追上工具本体

工具从 v1.7 一路迭代到 v1.9.x（多 Key、Codex 桌面版、Grok Build、出口并行竞速），
而插件文案还停在 1.0.1 的「Claude Code / Codex」。这次只改插件侧：

| 之前（1.0.1） | 现在（1.1.0） |
| --- | --- |
| 文案只提 Claude Code / Codex | 补上 Grok Build、每站多 Key、出口并行竞速 |
| 没就绪只有一句红字 | 按缺项给下一步：缺脚本 → 指定；缺解释器 → 装完点「重新检测」 |
| 状态只在打开面板时查一次 | 窗口重新获得焦点时自动复查，另加一个「重新检测」按钮 |
| 解释器显示整条路径（和入口那行重复） | 只显示 `pythonw.exe`，全路径留给入口那行 |
| 没说明它到底会写哪些文件 | 明说三个 CLI 的配置 + 「写入前自动备份、原子写」 |

**宿主侧零改动**：还是原来那 4 个 `apiprobe_app_*` 命令（外加 `plugin:dialog|open`），
`ToolSection` 里按 id 硬连的那处也没碰。装上新包即可，不需要重新编译应用。

## 为什么是"启动器"，而不是把功能搬进插件

那个工具的核心就是**发网络请求**和**写配置文件**，而 InfoBoard 的插件跑在 WebView 里：

| 限制 | 后果 |
| --- | --- |
| 受应用 CSP 约束（`connect-src` 只列了天气/B站等域名） | 发不出对中转站的请求 |
| 只能 import 白名单里的 4 个模块，没有文件写入能力 | 写不了 `~/.claude/settings.json`、`~/.codex/config.toml`、`~/.grok/config.toml` |
| 只在面板打开时活着 | 关掉面板就中断 |

三条限制正好把"探测 + 写配置"堵死，所以它保持**独立进程**，插件只负责把它拉起来。
同类做法的还有 `plugins/netdisk` 和 `plugins/bili-dl`。

## 安装

1. 把 `dist-plugins/api-probe-1.1.0.ibplugin` 拖进 **设置 → 插件管理**
   （或把 `plugins/api-probe/` 拷到 `%APPDATA%\com.infoboard.tauri\plugins\api-probe\`，
   再点「重新加载插件」）
2. 旧版 1.0.1 用同一个 id，直接覆盖安装即可，面板状态不用重建

> 这个插件需要**宿主本身**注册了 `apiprobe_app_*` 命令（0.6.0 之后才有）。
> 老版本应用上装了会提示"当前应用还没有 apiprobe_app_status 命令"，重新构建/安装即可。

## 第一次使用：指定一次位置

测活工具**不随应用打包**（它有自己的仓库、自己在迭代，vendored 一份进来只会立刻过期），
所以第一次点图标会**展开面板**让你指定入口：

```
点「📈 API」
   ├─ 已配置 → 直接启动
   └─ 没配置 → 展开面板 → 点「选择 api_probe.py…」→ 指到那个文件
                （之后会记住，再点图标就是直接开）
```

路径存在 `%APPDATA%\com.infoboard.tauri\companion-apps.json`，随时可以用面板里的
「换个位置…」改掉，或「改回自动查找」清掉。

不手动指定也能自动找到，宿主按这个顺序找、并取**修改时间最新**的一份：

1. `%APPDATA%` 里记住的手动路径（优先级最高）
2. 应用资源目录下的 `api-probe\api_probe.py`（随包分发时）
3. 可执行文件往上 5 层目录里的 `api-probe\api_probe.py`（开发时的仓库副本）
4. 当前工作目录下的 `api-probe\api_probe.py`

## 面板上的状态怎么读

| 显示 | 含义 | 下一步 |
| --- | --- | --- |
| 已就绪（pythonw.exe） | 脚本和解释器都找到了 | 点「打开测活工具」 |
| ⚠️ 没找到 api_probe.py | 只缺入口 | 点「选择 api_probe.py…」；文件名必须就叫这个 |
| ⚠️ 找到了程序，但没找到 Python 解释器 | 脚本在、解释器不在 PATH / 常见安装位置 | 装 Python 3.9+（带 tkinter），再点「重新检测」；还不行就重启 InfoBoard 刷新 PATH |
| ⚠️ 当前应用还没有 apiprobe_app_status 命令 | 应用版本太老 | 重新构建/安装 InfoBoard |

「重新检测」和窗口重新获得焦点时的自动复查，都只查**本机文件**，不会碰网络、不会读 Key。

## 工具侧最近改了什么（为什么这次要改插件文案）

这些改动都在 api-probe 本体里，插件代码不用跟着动；但"它能干什么、会写哪些文件"变了，
面板和本文就得说实话，否则用户会以为它只是个接 Claude Code 的小工具。

| 版本 / 提交 | 变化 |
| --- | --- |
| v1.7.0 | **一个站点多把 Key**：每把带名称和 OpenAI/Anthropic 格式标签；Claude 页默认挑 Anthropic 的，Codex 页默认挑 OpenAI 的，都能手改 |
| v1.8.0 | **Codex 桌面版**：与 CLI 共用 `~/.codex/config.toml`，Key 走用户级环境变量（`HKCU\Environment`），改完要重启桌面版 |
| v1.9.0 | **Grok Build 一键接入**：测 Chat / Responses / Messages 三条通道选 `api_backend`，合并 `~/.grok/config.toml` 的 `[model.api_probe]`，再跑一次 `grok -p PONG` |
| v1.9.1 | **出口并行竞速**：默认「系统代理 ∥ 直连」同时发，先回来的算数并记住赢家；界面删掉三选一下拉，只留可选的「额外代理」。连不上时不再误判成 Key 无效 |
| 三笔写入修复（HEAD，版本号仍是 1.9.1） | ① 合并 `config.toml` 时清掉**无标记**的同名 provider 表，写盘前校验合并结果；② 修数组表误删、模型名注入、`.env` 引号、重复 `_toml_str` 四处；③ 配置写盘统一改**原子写**（临时文件 + fsync + `os.replace`）、备份名同秒去重、读配置容忍 BOM |

最后一条对用户的意义：半截 TOML 会让 Codex 桌面版直接弹「无法加载组织设置」，
现在要么写成功、要么原文件一个字节不变；带 BOM 的 `config.toml` 也不会再被误判成非法。

> 面板文案按 **v1.9.x** 写。更老的工具照样能开，只是没有 Grok / 多 Key 那些功能；
> 想用全功能就把 `api_probe.py` 更新到最新。

## 排错

| 现象 | 原因 / 解决 |
| --- | --- |
| 面板显示「没找到 api_probe.py」 | 点「选择 api_probe.py…」手动指定一次 |
| 「不是一个文件」/「请选择名为 api_probe.py 的文件」 | 选错了对象。这个校验是故意的 —— 免得这个能力被当成"启动任意程序"的口子 |
| 「没找到 Python 解释器」 | 需要 Python 3.9+（自带 tkinter，Windows 官方安装包默认带）。装完点「重新检测」或重启 InfoBoard |
| 点了图标闪一下就没了 | 工具自己启动失败。直接 `python api_probe.py` 跑一次看报错 |
| 工具起来了但里面报网络错 | 那是工具自身的问题（中转站地址/Key/代理），跟插件无关；第一次探测慢十几秒是出口竞速在等另一条超时 |
| 想用打包版 `ApiProbe.exe` | 宿主只认 `api_probe.py` 这个入口名，并用 Python 拉起它。想从插件进就用源码版；exe 可以直接双击 |
| 工具里提示「不是合法 TOML」 | 更新到最新 `api_probe.py`（容忍 BOM、写前校验），或用工具页面上的「恢复上次备份」 |

## 它是怎么接的

```
工具区点「📈 API」
      │  ToolSection 按 id 直接动作（不展开面板；失败才展开去配置）
      ▼
apiprobe_app_launch  ──►  core::companion  ──►  pythonw api_probe.py
                            ├─ 找解释器：pythonw → python → pyw → py
                            └─ 找入口：用户指定 → 应用资源 → exe 上级 → cwd（取最新）
```

插件只声明了 5 个命令，权限面刻意收得很小：

```json
"tauriCommands": [
  "apiprobe_app_status",
  "apiprobe_app_launch",
  "apiprobe_app_set_path",
  "apiprobe_app_clear_path",
  "plugin:dialog|open"
]
```

**没有"通用启动命令"**：宿主给每个伴随程序一组独立命令（网盘下载器是
`netdisk_app_*`），插件只能启动自己那一个，借不了道去启动别的。

图标用宿主 `SVG_ICONS` 注册表里的 Lucide `activity`（脉冲折线），与截图 /
设置 / 翻译 / 网盘下载一致，都是具名线性图标。

## 相关

- 工具本体：[Irisrespect/api-probe](https://github.com/Irisrespect/api-probe)
- 宿主设施：`src-tauri/src/core/companion.rs`
- 另一个同款启动器插件：`plugins/netdisk/`
