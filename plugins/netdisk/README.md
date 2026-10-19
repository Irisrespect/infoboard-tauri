# 网盘下载（InfoBoard 插件）

工具区一个图标，点开独立的 **[网盘下载器](../netdisk-app/README.md)** ——
输入夸克网盘分享链接 + 提取码，解析目录，多连接高速下载。

```bash
node scripts/pack-plugin.mjs plugins/netdisk
# → dist-plugins/netdisk-1.2.1.ibplugin
```

## 为什么是"启动器"，而不是把功能搬进插件

插件跑在 WebView 里，有三条硬限制正好卡住"下载"这件事：

| 限制 | 后果 |
| --- | --- |
| 受应用 CSP 约束（`connect-src` 只列了天气/B站等域名） | 发不出对网盘接口的请求 |
| 只能 import 白名单里的 4 个模块，没有文件写入能力 | 写不了下载的文件 |
| **只在面板打开时运行** | 面板一关，直链过期（5~10 分钟）就没人换链，大文件必然下不完 |

最后一条是最要命的，也是当初把主力从插件里搬出去的直接原因。
独立进程自己就能一直下、自己换链，关掉 InfoBoard 也不受影响。

## 安装

1. 把 `dist-plugins/netdisk-1.2.1.ibplugin` 拖进 **设置 → 插件管理**
   （或把 `plugins/netdisk/` 拷到 `%APPDATA%\com.infoboard.tauri\plugins\netdisk\`，
   再点「重新加载插件」）

> 需要 0.6.0 之后的应用（那时才有 `netdisk-app/` 随包分发与 `netdisk_app_*` 命令）。

## 用法

点工具区的 **☁️ 夸克网盘** 图标 → 直接弹出下载器窗口（**不展开面板**，与截图插件同一套做法）。
启动失败（比如本机没装 Python）会弹一个原生错误框说明原因。

下载器本体怎么用、支持哪些网盘、免费速度的真相，见 [netdisk-app/README.md](../netdisk-app/README.md)
与 [docs/NETDISK.md](../docs/NETDISK.md)。

## 排错

| 现象 | 原因 / 解决 |
| --- | --- |
| 点图标没反应 | 十有八九是没装 Python（3.10+，自带 tkinter）。通常会弹错误框；也可以直接 `python netdisk-app/main.py` 看报错 |
| 「插件未声明命令」 | 应用版本太老，重新构建/安装；`src/__tests__/netdiskPlugin.test.ts` 会在 CI 提前拦下这类不同步 |
| 下载中途显示「直链过期，换链中…」 | 正常自愈过程。一直停着说明换链失败，会带原因 |

## 它是怎么接的

```
工具区点「☁️ 夸克网盘」
      │  ToolSection 按 id 直接动作（与截图插件同一套做法）
      ▼
netdisk_app_launch  ──►  core::companion  ──►  pythonw netdisk-app/main.py
                            ├─ 找解释器：pythonw → python → pyw → py
                            └─ 找入口：随包资源 → exe 上级 → cwd
```

插件只声明了 2 个命令，权限面刻意收得很小：

```json
"tauriCommands": ["netdisk_app_status", "netdisk_app_launch"]
```

它**拿不到** HTTP 转发、Cookie 读写、写文件这些能力 —— 那些能力曾经属于"应用内下载"，
在插件改成纯启动器之后就删掉了。

图标用宿主 `SVG_ICONS` 注册表里的 Lucide `cloud-download`，与截图 / 设置 / 翻译 /
API 一致，都是具名线性图标。
