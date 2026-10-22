# 翻译（外部插件）

内置 `translate` 的**重建版**，现在是一个可分发的 `.ibplugin` 包。

> **v2.2 移除了截屏取字（OCR）。** 现在只有文字翻译。
> 仓库里独立的截图插件（`src/plugins/screenshot/`）不受影响 ——
> 它自己的截图 + 「识别文字」仍然在。

## 能力

| 能力 | 说明 |
| --- | --- |
| **多引擎** | 小牛 / OpenAI 兼容（中转站、本地模型）/ DeepL / Google / MyMemory |
| **失败自动换引擎** | 顺序尝试，结果卡上标明"这一条是谁翻的" |
| **历史 + 收藏** | 最近 40 条 + 收藏 100 条，点一下回填到翻译区 |
| **语言互换 / 自动识别** | 源语言按文字脚本猜（假名→日语、谚文→韩语、汉字→中文…） |
| **长文分片** | 超过单次上限自动按段落切开再拼回 |

## 安装

**方式一（推荐）**：设置 → 插件管理 → 把 `dist-plugins/translate-2.2.0.ibplugin` 拖进去。
**方式二（开发）**：

```powershell
$dst = "$env:APPDATA\com.infoboard.tauri\plugins\translate"
New-Item -ItemType Directory -Force $dst | Out-Null
Copy-Item plugins\translate\* $dst -Force
```

然后 设置 → 插件管理 → 重新加载插件。

> 需要宿主 ≥ 0.8：多引擎走 `translate_web` 命令（小牛仍走 `niutrans_*`）。
> 旧版宿主上插件仍能加载，但除小牛外的引擎会报"未知命令"。

## 引擎与 Key

Key **只进 Windows 凭据管理器**，前端与 `localStorage` 都不留明文：

| 引擎 | 凭据名 | 需要 |
| --- | --- | --- |
| 小牛翻译 | `niutrans` | App ID + API Key（[申请](https://niutrans.com/cloud/api/list)） |
| OpenAI 兼容 | `translate-openai` | Base URL + 模型名 + Key |
| DeepL | `translate-deepl` | Auth Key（免费版选 `api-free`） |
| Google | — | 免 Key（可能被墙） |
| MyMemory | — | 免 Key，单次 ≤ 500 字节 |

没配任何 Key 时插件仍然可用 —— 会自动落到免 Key 引擎。

## 为什么多引擎要 Rust 帮忙

外部插件跑在 WebView 里，`tauri.conf.json` 的 CSP `connect-src` 是白名单，
DeepL / OpenAI / Google 都不在里面，插件**发不出**这些请求；插件侧也没有通用
HTTP 命令。所以多引擎落在 `src-tauri/src/plugins/webtranslate/`：
`translate_web` 用 reqwest 直连，Key 由 Rust 从凭据管理器读，CSP 与它无关。

## 开发

```bash
npm run typecheck:plugins          # 插件入口的类型检查（tsconfig.plugins.json）
npm run smoke:plugin               # 用应用同款 sucrase 转译+求值，验证真的能加载
node scripts/pack-plugin.mjs plugins/translate   # 产出 dist-plugins/translate-<ver>.ibplugin
```

改完源码不必打包：把目录同步到 `%APPDATA%\com.infoboard.tauri\plugins\translate\`
后点「重新加载插件」即可。
