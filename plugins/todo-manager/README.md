# 待办（外置插件 · 独立窗口启动器）

信息区的待办卡片（`src/plugins/todo/TodoCard.tsx`）只做「看 / 勾选 / 快速添加」。
**条目级的增删改、筛选、批量清理、撤销**在一个**独立窗口**里做，这个插件就是那个窗口的入口。

插件本身**不渲染管理页**：点工具区的「待办」图标 → 直接调 `todo_window_open` →
弹出 `index.html#/todo`（窗口 label `todo-manager`）。管理页的代码在宿主里
（`src/plugins/todo/TodoManagerWindow.tsx`，`src/main.tsx` 的 `#/todo` 路由），
开窗命令在 `src-tauri/src/plugins/todowin/mod.rs`。

> 为什么管理页不在插件里：待办数据在宿主的 zustand store（`src/plugins/todo/store.ts`），
> 而外置插件由 `src/core/pluginRuntime.ts` 用 sucrase 转译后在受控 `require` 里执行 ——
> 是**另一个模块实例**，import 不到宿主的 store / utils。硬塞进插件只有两条路：复刻一份
> 数据层（两份实现必然分叉：日期解析、排序、逾期判定都得抄），或者走事件桥（凭空多一层
> 跨窗口协议）。都不如让宿主自己开个窗口直接渲染。

## 窗口里能做什么

| 操作 | 说明 |
| --- | --- |
| 添加 | 文本 + 可选截止日期；Enter 与「添加」按钮同效 |
| 截止日期 | 支持 `2026-03-08` 与 `3月8日`（中文按"下一次出现"规则定年，跨年自动算明年） |
| 勾选完成 | 只有左侧勾选框能切换（整行不可点，避免拖选/双击误勾） |
| 行内编辑 | Enter 保存 / Esc 取消 / 失焦保存；空文本不保存，输入法拼字中 Enter 不提交 |
| 删除 | toast 里带「撤销」，按 id 去重插回 |
| 批量清理 | 「已完成」筛选下出现；同样可撤销 |
| 筛选 | 全部 / 进行中 / 已完成 |

## 数据存在哪、怎么同步

- 唯一数据源：`localStorage['todo-list']`（键名 `storage.TODO_STORAGE_KEY`）。
- 窗口与信息区卡片共用同一份数据，靠浏览器原生的 **`storage` 事件**跨窗口同步：
  任一窗口写盘后，同源的其他窗口自动重读（`src/plugins/todo/store.ts` 的
  `bindStorageListener`）。插件自己**不读写** localStorage，也不需要广播任何事件。
- `todo-list` 不是合法数组时进入只读态：先把原文备份到 `todo-list-corrupt-<时间戳>`，
  界面上禁用所有写操作，避免写一次就把待救的数据覆盖掉。

## 硬约束（改这个插件时必须知道）

1. **只能 import 四个模块**：`react`、`react/jsx-runtime`、`react-dom`、`@tauri-apps/api/core`。
   `lucide-react`、`clsx`、宿主的 `../todo/store` 之类一律在求值时报错。
2. **一个类名都不许写**：`tailwind.config.ts` 的 `content` 只有 `./index.html` + `./src/**`，
   `plugins/` 下的类名不会被生成，写上去等于没写。样式全部内联 `style`。
3. **单文件**：`manifest.entry` 指向的就是 `index.tsx`，不能拆文件互相 import。
4. **命令要申报**：`invoke('todo_window_open')` 能否调用由 `manifest.json` 的
   `tauriCommands` 决定，没声明的命令会被运行时的包装器直接 reject（fail-closed）。
   换命令名时 manifest 与 `index.tsx` 要一起改。

## 打包与分发

```bash
node scripts/pack-plugin.mjs plugins/todo-manager
```

产出 `dist-plugins/todo-manager-<version>.ibplugin`（就是个 zip：`manifest.json` + 入口文件）。
把它拖进「设置 → 插件管理」即可安装。可选参数见 `node scripts/pack-plugin.mjs --help`
（`-o/--out <目录>` 换输出目录；`--companion <目录>` 只有声明了伴随程序的插件才需要，这个插件不需要）。

> 仓库里的 `plugins/todo-manager/` 只是**源码目录**：运行时只扫
> `%APPDATA%\com.infoboard.tauri\plugins`。
> 开发时想直接生效，把 `manifest.json` + `index.tsx` 拷到
> `%APPDATA%\com.infoboard.tauri\plugins\todo-manager\`，再在插件管理里重新加载。

## 开发

```bash
npm run typecheck:plugins                        # 插件入口类型检查（tsconfig.plugins.json）
npm run smoke:plugin -- plugins/todo-manager     # 用应用同款 sucrase 转译 + 求值 + 校验导出形状
node scripts/pack-plugin.mjs plugins/todo-manager
```
