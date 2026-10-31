# api-probe-app（「API」插件的伴生程序）

`api_probe.py`：**单文件、零第三方依赖**的「API 中转站测活工具」（Python 3.9+，自带 tkinter 即可跑）。

- 多站点 + 每站多 Key、模型/协议探测、生成测速、批量巡检
- 一键接入 Claude Code / Codex / Grok Build（检测通道 → 映射模型 → 写配置 → 端到端验证）
- 也支持纯命令行：`python api_probe.py --url <站点> --key <key> --json`

## 为什么放在仓库里

这个程序以前**不在仓库**里（`src-tauri` 的伴随程序注册表指向 `api-probe/api_probe.py`，
但那个目录从未进过仓库），于是「API」插件在别的机器上只能靠用户手动指定路径才起得来。

现在：

- 程序本体进仓库 → 可复现地打包；
- 插件 `plugins/api-probe/` 通过 `companion` 声明**把程序打进 `.ibplugin`**
  （`app/api_probe.py`），导入即用，不需要安装整个应用；
- `src-tauri/tauri.conf.json` 的 `resources` 也把本目录映射到安装包的 `api-probe/`，
  作为"没装插件时的兜底"。

## 版本

`VERSION` 是唯一事实源（当前 `1.10.0`），必须与 `plugins/api-probe/manifest.json`
的 `companion.version` 一致 —— 打包脚本会强制校验。

```bash
node scripts/pack-plugin.mjs plugins/api-probe --companion api-probe-app
# → dist-plugins/api-probe-1.10.0.ibplugin（含 app/api_probe.py）
```

## 直接运行（不走 InfoBoard）

```bash
python api-probe-app/api_probe.py          # 图形界面
python api-probe-app/api_probe.py --help   # 命令行参数
```
