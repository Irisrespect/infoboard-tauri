# 启动器插件模板（插件自带程序）

这是「新功能只发一个 `.ibplugin`」的模板：**插件自带一个独立程序**，
宿主只负责把它拉起来。宿主**不需要认识这个插件** —— 导入包即可用。

```
.launcher-template/
├── manifest.json      声明 companion（程序在哪、版本多少）
├── index.tsx          插件界面：只有"打开"按钮 + 状态（真正的活都交给程序）
└── app/
    ├── VERSION        版本唯一事实源（必须与 manifest.companion.version 一致）
    └── main.py        你的程序（tkinter / WebView / 命令行都行）
```

## 什么时候用这个模板

| 你要做的事 | 用这个模板？ |
| --- | --- |
| 纯展示 / 交互 / 表单 / 调用现有命令 | ❌ 用 `.plugin-template`（纯前端，包更小） |
| 要访问任意外网（CSP 只放行白名单域名） | ✅ |
| 要写文件 / 读本地目录 | ✅ |
| 要常驻运行（面板关掉也得继续干活） | ✅ |
| 要用第三方 SDK / 本地服务 / 定时任务 | ✅ |

## 复制 & 改名

```bash
cp -r plugins/.launcher-template plugins/my-tool
# 然后改三处 id/name：
#   manifest.json 的 id / name / description
#   index.tsx 的 PLUGIN_ID / manifest
```

## 打包（程序会一起进包）

```bash
node scripts/pack-plugin.mjs plugins/my-tool --companion plugins/my-tool/app
# → dist-plugins/my-tool-1.0.0.ibplugin
```

## 发版只改程序时

改 `app/` 里的代码 → 改 `app/VERSION`（如 `1.0.1`）→ 同步 manifest 的
`version` 与 `companion.version` → 重新打包 → 用户把新 `.ibplugin` 拖进
**设置 → 插件管理** 覆盖安装即可。**不需要重装 InfoBoard。**

## 安全边界（宿主保证的）

`companion_launch` 只接受 **id**，路径由宿主按 `<plugins>/<id>/<companion.dir>/<entry>`
拼出来：

- 插件启动不了别人的程序；
- 插件启动不了自己包外的东西；
- 插件包的条目数/体积上限 64 / 8 MB（`plugins/pack.rs`）。

所以「导入一个包」= 「装一个程序」—— 权限模型是**用户用拖拽明确授权的**，
不是插件之间互相授予的。给用户看的说明写清楚这一点。

## 没有 Python 的机器

`companion.kind` 可以写成 `"exe"`，宿主会直接执行 `app/` 里那个可执行文件，
不需要 Python。但注意 8 MB 上限 —— 带运行时的打包（PyInstaller 等）通常放不下，
那种情况应该做成独立安装器，而不是塞进插件包。
