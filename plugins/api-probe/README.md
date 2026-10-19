# API 测活（InfoBoard 插件）

工具区一个图标，点开独立的 **[API 中转站测活工具](https://github.com/Irisrespect/api-probe)** ——
站点与多 Key 管理、模型列表探测、批量测速与流畅度、一键接入 Claude Code / Codex。

```bash
node scripts/pack-plugin.mjs plugins/api-probe
# → dist-plugins/api-probe-1.0.0.ibplugin
```

## 为什么是"启动器"，而不是把功能搬进插件

那个工具的核心就是**发网络请求**和**写 Claude Code / Codex 的配置文件**，
而 InfoBoard 的插件跑在 WebView 里：

| 限制 | 后果 |
| --- | --- |
| 受应用 CSP 约束（`connect-src` 只列了天气/B站等域名） | 发不出对中转站的请求 |
| 只能 import 白名单里的 4 个模块，没有文件写入能力 | 写不了 `~/.claude/settings.json`、`config.toml` |
| 只在面板打开时活着 | 关掉面板就中断 |

所以它保持**独立进程**，插件只负责把它拉起来。同类做法的还有 `plugins/netdisk`。

## 安装

1. 把 `dist-plugins/api-probe-1.0.0.ibplugin` 拖进 **设置 → 插件管理**
   （或把 `plugins/api-probe/` 拷到 `%APPDATA%\com.infoboard.tauri\plugins\api-probe\`，
   再点「重新加载插件」）

> 这个插件需要**宿主本身**注册了 `apiprobe_app_*` 命令（0.6.0 之后才有）。
> 老版本应用上装了会提示"当前应用还没有 apiprobe_app_status 命令"，重新构建/安装即可。

## 第一次使用：指定一次位置

测活工具**不随应用打包**（它有自己的仓库、自己在迭代，vendored 一份进来只会立刻过期），
所以第一次点图标会**展开面板**让你指定入口：

```
点「📈 API 测活」
   ├─ 已配置 → 直接启动
   └─ 没配置 → 展开面板 → 点「选择 api_probe.py…」→ 指到那个文件
                （之后会记住，再点图标就是直接开）
```

路径存在 `%APPDATA%\com.infoboard.tauri\companion-apps.json`，随时可以用面板里的
「换个位置…」改掉，或「改回自动查找」清掉。

## 排错

| 现象 | 原因 / 解决 |
| --- | --- |
| 面板显示「没找到 api_probe.py」 | 点「选择 api_probe.py…」手动指定一次 |
| 「不是一个文件」/「请选择名为 api_probe.py 的文件」 | 选错了对象。这个校验是故意的 —— 免得这个能力被当成"启动任意程序"的口子 |
| 「没找到 Python 解释器」 | 需要 Python 3.9+（自带 tkinter，Windows 官方安装包默认带）。装完重启 InfoBoard |
| 点了图标闪一下就没了 | 工具自己启动失败。直接 `python api_probe.py` 跑一次看报错 |
| 工具起来了但里面报网络错 | 那是工具自身的问题（中转站地址/Key/代理），跟插件无关 |

## 它是怎么接的

```
工具区点「📈 API 测活」
      │  ToolSection 按 id 直接动作（不展开面板；失败才展开去配置）
      ▼
apiprobe_app_launch  ──►  core::companion  ──►  pythonw api_probe.py
                            ├─ 找解释器：pythonw → python → pyw → py
                            └─ 找入口：用户指定 → 随包资源 → exe 上级 → cwd
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

图标用宿主 `SVG_ICONS` 注册表里的 Lucide `activity`（脉冲折线），与截图 / 设置 /
翻译 / 网盘下载一致，都是具名线性图标。

## 相关

- 工具本体：[Irisrespect/api-probe](https://github.com/Irisrespect/api-probe)
- 宿主设施：`src-tauri/src/core/companion.rs`
- 另一个同款启动器插件：`plugins/netdisk/`
