# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.9.0] - 2026-10-31

### Added

- **开放「插件自带程序」：新功能只发一个 `.ibplugin`，宿主不用改**（P3）
  - 宿主不再只认注册表里那三个 id：任何插件在 manifest 里声明 `companion` 后，
    `companion_status` / `companion_launch` 就能按**插件 id** 拉起它包里的程序
    （0.8 及更早的宿主只认 `netdisk` / `apiprobe` / `bilidl`）
  - 路径**只由宿主拼**（`<plugins>/<id>/<companion.dir>/<entry>`），命令只收 id 不收路径
    —— 插件启动不了别人的程序，也启动不了自己包外的东西；不再需要"借
    `companion_set_path` 指向任意 main.py"那种借道写法
  - `companion.kind` 新增 `"exe"`：自带可执行文件的插件不需要用户装 Python
  - `companion_list` 会把"注册表 + 插件自带"一起列出来（`source` / `version` / `present`）
  - 新增模板 [`plugins/.launcher-template/`](plugins/.launcher-template/README.md)：
    复制改名 → `--companion app` 打包 → 拖进插件管理，附带 4 条守卫测试
- **插件可以自带伴随程序（`companion`）：启动器类插件终于能热更新了**
  - 以前的坑：`netdisk` / `api-probe` / `bilidl` 这三个插件的"本体"是独立程序，
    程序只随**应用安装包**的 resources 发 —— 于是改一行 Python 也要让用户重装整个
    InfoBoard，`.ibplugin` 这个热更新通道对它们形同虚设（插件版本号只能空转，
    2.0.1 / 2.0.2 就是这种错位的产物）
  - manifest 新增 `companion: { dir, entry, version }`：`pack-plugin.mjs --companion <程序目录>`
    会把程序一起打进包（自动排除 `__pycache__` / `*.pyc` / `tools/`，
    条目 ≤ 64、解压后 ≤ 8 MB，与宿主上限一致）
  - 宿主查找顺序：用户指定 → **插件包自带** → 随包 resources / exe 上层 / cwd（取最新）；
    后三者仍按修改时间竞争，所以开发时仓库里那份依旧生效
  - 插件的 `source` 多了 `plugin` 取值；`AppStatus` 增加 `version` / `expected` 两个字段
- **版本契约（防"插件说自己是新版、里面装的是旧程序"）**
  - `netdisk-app/VERSION` 作为唯一事实源；`main.py --version` 可查
  - 打包时强校验 `manifest.companion.version == VERSION`，不一致直接拒绝出包
  - 运行期再比一次：宿主读实际入口旁的 `VERSION`，与 manifest 声明不一致就
    **弹 toast（warn）+ 写日志**，而不是静默跑旧代码
  - Rust 侧新增 4 个单测（`companion` 解析/越界拒绝/读 VERSION/漂移判定），
    前端新增 3 个（自带程序进包、缺 `--companion` 拒绝出包、版本一致性）
- **「网盘下载」把夸克和迅雷合并成一个插件、一个窗口**
  - 桌面上的「迅雷下载器」（`XunleiDL/`）按伴随程序那套做法**搬进仓库**：
    协议实现落到 `netdisk-app/netdisk/xunlei.py`，WebView 执行器落到
    `netdisk-app/netdisk/bridge_worker.py`
  - 插件的显示名从「夸克网盘」改回「网盘下载」（id 仍是 `netdisk`），
    拉起的是同一个 `netdisk-app/main.py` —— 现在它两家都认
  - 为什么迅雷必须走 WebView：分享接口对每个请求都要 `captcha_token`，而它要
    `captcha_sign`（设备签名），旧算法已失效（服务端 `invalid captcha_sign`）。
    网页自己能算，所以加载分享页、在**页面上下文里** fetch 同一批接口 —— 不逆向签名。
    pywebview 的 `webview.start()` 会抢主线程，跟 tkinter 的 `mainloop()` 必炸，
    因此单独成**子进程**，结果走 JSON 文件（`pythonw` 下 stdout 不可靠）
  - 迅雷登录走官方扫码页，token 只留在 WebView 的 profile 里；主程序只落一个
    `user_id` 标记。**旧「迅雷下载器」的 profile 会被复制过来一次**（仅当新目录为空），
    升级过来的人不用重扫
  - 合并后的界面：一个输入框 + 实时「识别为：夸克网盘 / 迅雷云盘」提示，
    提取码可以留在链接里（两家都会自己拆）；设置改成三个标签页（通用 / 夸克 / 迅雷）
  - 两家的差别都收在适配器后面（`netdisk/services.py` 注册表）：
    `main.py` 不认识具体网盘，加第三家只改注册表
  - 新增可选钩子 `prefetch()` / `invalidate()`：迅雷靠前者把"转存 N 个文件"
    合成**一次** WebView 请求（逐个转存 = 每个文件开一次浏览器），
    靠后者在直链过期时丢掉缓存（否则换链回调会把同一条死链再交出去）
  - 新增 `netdisk-app/tools/smoke_xunlei.py`：离线假 runner，14 个案例盖住
    "整棵树摊成邻接表 / 翻目录不再开浏览器 / 批量转存与 cleanup 透传 /
    直链过期丢缓存 / 未登录只下小文件 / 批量失败后快速失败且可重试 /
    JS 模板占位符全替换 / 登录态提取 / 标记同步 / 旧 profile 迁移 / 接口错误翻人话"
  - 插件改用**通用伴随程序命令**（`companion_status` / `companion_launch` /
    `companion_set_path` / `companion_clear_path`），于是自动找不到入口时可以
    在面板里手动指定一次 `main.py`；旧的 `netdisk_app_*` 保留不动，不打断已装插件
  - 插件版本 1.2.1 → **2.0.0**；`dist-plugins/netdisk-2.0.0.ibplugin`

- **迅雷登录态自动续期（refresh_token）**，扫码一次可以长期有效
  - 端点用**实测可用**的 `POST https://xluser-ssl.xunlei.com/v1/auth/token`
    （`{client_id, grant_type:"refresh_token", refresh_token}`）。
    旧「迅雷下载器」里写的 `/v1/auth/refresh` 现在返回 `404 {"error":"not_found"}`，
    照抄旧代码会一直以为"续期这条路走不通"
  - 两个触发点：**转存前**（已知 10 分钟内过期才续，避免白发请求）与
    **转存撞上 401/403 后**（续一次 → 写回 localStorage → **重试一次**）。
    过期时间未知时**不主动续** —— refresh_token 可能是轮换的，用一次少一次
  - 续期在**同一个 WebView 窗口**里完成：读 token → Python 发请求 → 写回页面 →
    接着跑转存。不额外开窗口，也就没有第二次 10 秒等待
  - 写回是破坏性操作，所以**先验形态**：新 token 不是 JWT 且没有未来过期时间就
    保持原样不写 —— 宁可这次没续上，也不能把还能用的登录态覆盖成垃圾
  - 续期失败**不阻断下载**（老 token 可能还能用）；真不行会以"登录态已过期"收场
  - 设置 → 迅雷新增「刷新登录态」按钮 + 状态行显示"还有约 N 小时"；
    转存时若自动续过期，下载队列上方会提示一句
  - 顺手修掉一个误判：**"页面没加载出来" ≠ "没登录"**。检查登录态时若一次都没读到
    页面存储，现在返回错误而**不删**登录标记（以前断网点一下「检查」就会翻成"未登录"）
  - `smoke_xunlei.py` 增至 **18 个案例**：续期决策边界、三种返回形态、四种结局
    （有效/续成功/无 refresh_token/被拒）、token 形态校验、端点与错误翻译

- **网盘下载器新增命令行版（`netdisk-app/netdisk_cli.py`）**
  - 和 GUI 共用同一套适配器/下载引擎，也共用同一份 `config.json`：在界面里登录过，
    直接在终端 `get` 就是登录态（配置搬进 `netdisk/config.py`，两边不再各存一份默认值）
  - 子命令：`ls`（列目录，序号喂给 `--index`）/ `tree`（目录树）/ `get`（下载）/
    `login`（夸克粘 Cookie、迅雷扫码、看状态）/ `config`（保存目录、并发等）
  - `get` 支持 `--path`（进子目录）、`--index 1,3-5`、`--only/--exclude` glob、
    `--limit`、`-j`（并行下几个文件）、`--dry-run`、`--json`、`--overwrite`
  - 进度板：tty 上多行原地重绘（ANSI，行数变少时擦干净），管道/重定向里只留
    "开始/完成"行；`--json` 时 stdout 只有 JSON（人类可读的摘要全关掉）
  - 单文件失败不带走整批，最后汇总并按退出码区分：`0` 全成功 / `1` 有失败 /
    `2` 用法或解析错误 / `130` Ctrl+C
  - `--only` 匹配的是**展开后的相对路径**（`*.mp4` 能命中任意层），落盘仍自动加
    `\\?\` 长路径前缀，深层目录不会撞 MAX_PATH
  - `netdisk.cmd`：进 PATH 后可以直接 `netdisk get "..."`（ASCII + CRLF，避免 cmd 按
    GBK 解析中文注释时把批处理弄坏）
  - `tools/smoke_cli.py`：29 项检查，含"假适配器 + 本地 HTTP"跑完整 `get` 流程
    （不碰网盘）：选择/过滤、进度板重绘序列、过期换链、单文件失败隔离、退出码
  - 文档：`docs/NETDISK_CLI.md`（子命令与参数、`--only` 匹配规则、JSON 结构、
    脚本/计划任务示例、排错表、已知限制），`netdisk-app/README.md` 挂上入口

### Changed

- **DeepSeek HUD 改成磨砂玻璃透明窗**
  - `transparent(true)` + `background_color(Color(0,0,0,0))`：Windows 上 alpha 非 0 会被忽略
  - 关键：透明窗口只能露出「页面没画」的地方，而 DeepSeek 是 SPA（`body` / `#root` /
    侧栏 / 气泡各画各的底），所以建窗时挂 `initialization_script`（`HUD_GLASS_SCRIPT`）
    在 document-created 阶段注入三层样式：根元素铺半透明玻璃 + `backdrop-filter`
    → 清 `body`/`#root` 底色 → 扫铺满视口的不透明层兜底；`MutationObserver`
    跟着 SPA 换页/换主题重挂
  - 实测（真机截图）：壁纸透出、欢迎页/输入框/按钮清晰可读、可正常交互
  - 已知限制：系统标题栏无法透明（远端页面调不到 `invoke`，做不了自绘拖拽区）；
    文字配色仍是站点自己的，深色主题透到浅色桌面时对比度会降 —— 透明度在
    `HUD_GLASS_SCRIPT` 里改一行即可
- 新增 debug-only 逃生口 `INFOBOARD_ALLOW_MULTI_INSTANCE=1`：不注册单实例插件，
  于是可以在「正在用的那一份」还开着时另起一个实例跑自检/截图，不用先关掉
  （关掉会连带杀掉 vite dev server，主窗口就变成 localhost 拒绝连接）

### Fixed

- **迅雷下载报 `ValueError: could not convert string to float: '…Z'`（转存全挂）**
  - 触发：点下载大文件 → 需要「转存到自己云盘」→ 转存前先判断要不要续期 →
    `float(页面里的 expires_at)` 撞上 `2026-10-31T19:15:39.367Z` 直接抛，
    整单转存被判死，界面显示「部分文件没能开始下载」（报错跟时间毫无关系，很难联想）
  - 根因：迅雷网页版 localStorage 把 `expires_at` 存成 **ISO 8601 字符串**，
    而代码按数字处理（`read_page_creds` 只在值为空时才补 JWT 的 `exp`，非空就原样透出）
  - 修法：`netdisk/core.py::epoch_seconds` + `bridge_worker.to_epoch` 统一解析
    （数字 / 数字字符串 / ISO（带 `Z`、带 `+08:00`、无时区按 UTC）/ 毫秒时间戳），
    **认不出来返回 0（= 不知道）而不是抛错** —— 语义正是"等真撞上 401 再续"；
    写回页面时按页面原样式写（ISO 进 ISO 出，别把字符串改成数字）
  - 顺带修掉报错里文件名重复两层（`a.exe：a.exe：…`）
  - 回归：`smoke_xunlei.py` 新增「过期时间三种写法都认」「页面存 ISO 也能正常续期」
  - 插件版本 2.0.1 → **2.0.2**，重新出包 `dist-plugins/netdisk-2.0.2.ibplugin`
    （插件仍是纯启动器；上面的改动全在 `netdisk-app/`，随应用资源打包）
- **网盘下载：目录超过 6 层就下不了（夸克尤其明显）**
  - 根因是 `main.py` 的 `App._walk()` 里写死 `if depth >= 6: raise NetdiskError(...)`：
    夸克分享的 `课程/第 1 章/第 1 节/素材/配图/原图/…` 随手就 7 层，
    于是**整批下载在"展开目录"阶段就失败，一个文件都下不到**
  - 展开逻辑抽到 `netdisk/tree.py`：显式栈（不再受递归深度影响）、深度上限可配
    （默认 32，设置界面里能改）、到顶只跳过那棵子树并提示，**同级的其它文件照下**；
    单个子目录列不出来也只记一条提示，不再连坐整批
  - 同时修掉两个同源的坑：夸克 `list_dir` 只取第 1 页（`_size=200`），
    装 250 个文件的目录会**静默少下 50 个** → 现在按 `_page` 翻页取全；
    深层目录 + 中文名超过 `MAX_PATH=260` 时 `mkdir`/`open` 直接报
    WinError 206/3 → 现在创建目录与打开文件统一走 `core.fs_path()`
    自动加 `\\?\` 前缀（不改注册表），单项名字过长会截断到 120 字符
  - 迅雷侧同步放宽：`bridge_worker` 注入的 JS 与 `xunlei._index()` 的层数上限
    从 6/8 统一到 `MAX_TREE_DEPTH = 24`（用 `__MAX_DEPTH__` 注入，两边有测试盯着）
  - 新增回归：`smoke_adapter.py` 覆盖 250 项翻页、10 层展开、单目录失败不连坐
  - **展开改成按层并发**（文件多的分享不用干等了）：夸克一层目录一次请求
    （200~600ms），500 个目录串行要好几分钟。现在同一层的目录一起列
    （默认 6 路，设置里 1~16 可调），结果按接口顺序合并 → **顺序不变、耗时÷并发数**
    （实测 25 个目录：串行 1260ms / 6 路 253ms / 12 路 153ms）。
    默认只给 6 路是因为这是别人的分享接口，太猛会被临时限流（整层失败并提示）；
    迅雷侧 `parallel_expand = False` —— 它解析时整棵树已在本地，`list_dir` 只是查字典。
  - 插件版本 2.0.0 → **2.0.1**，重新出包 `dist-plugins/netdisk-2.0.1.ibplugin`
    （插件本身仍是纯启动器；`netdisk-app/` 的改动随应用资源打包，
    安装版要 `npm run tauri build` 才会带上，仓库内直接跑则改完即生效）

## [0.8.0] - 2026-10-22

### Added

- **DeepSeek 网页 HUD**（外部插件 `plugins/deepseek/` + 命令 `hud_open_deepseek`，
  `src-tauri/src/plugins/hud/`）
  - 点工具区图标直接弹出一个常驻小窗，里面是 chat.deepseek.com **本身**
    （独立 webview，不是 iframe）
  - 为什么不用 iframe：站点用 `X-Frame-Options` / `frame-ancestors` 拒绝被嵌；
    而且主窗口实测只有 399px 宽，聊天区会被挤成一条缝
  - 贴主窗口左侧打开（左边放不下就换右侧），有标题栏、可缩放、置顶、不占任务栏；
    尺寸位置由 `tauri-plugin-window-state` 记住；已开着的直接唤到前面
  - 日志残留在 WebView2 自己的数据目录里，关掉应用再开不用重登
  - 安全：URL 是编译期常量 + 只认 https + 远端页面**不授予任何 Tauri 权限**
    （未配 `dangerousRemoteDomainIpcAccess`，页面调不了 invoke）
  - `ToolSection` 按 id 特判成"直接动作"，不展开面板（与网盘 / B 站下载器同一套做法）
  - **图标换成自绘的 `whale`**（Lucide 风格鲸鱼：24 网格 / 2px 描边 / 圆头圆角 /
    无填充，一条闭合轮廓 + 一个眼睛点），替代原来的 emoji 🐋 —— emoji 是彩色字形，
    粗细尺寸都不受控，和工具区其它线性图标不是一套。体量按真机截图调过：
    内容撑满 x 2.2–22.4 / y 5.6–20.6，与 `languages`、`camera` 对齐
  - 附带 `scripts/icon-preview.ps1`：把 SVG path 渲染成 PNG 的预览工具
    （GDI+ 直译 M/L/C/H/V/Z），画新图标时先看效果再落地
- **翻译插件重建为外部插件包**（`plugins/translate/`，v2.0.0 → **v2.2.0**）
  - 多引擎：小牛 / OpenAI 兼容（中转站、本地模型）/ DeepL / Google / MyMemory，
    失败按可用性自动换下一个，结果卡标明"这一条是谁翻的"
  - 历史（40 条）+ 收藏（100 条），点一条回填到翻译区；源语言按脚本自动识别；
    一键互换；长文按段落分片后再拼回
  - Key 仍只进 Windows 凭据管理器：新增凭据名 `translate-openai` / `translate-deepl`
    （`core/secrets.rs` 白名单同步扩了），前端与 `localStorage` 不留明文
  - v2.1 曾加过"截屏取字（全屏框选 → OCR）"，**v2.2 已整条移除**（见 Removed）
- 新增 `translate_web` 命令（`src-tauri/src/plugins/webtranslate/`）：**多引擎必须走
  Rust**，因为 WebView 的 CSP `connect-src` 是白名单，插件发不出对 DeepL / OpenAI /
  Google 的请求，插件侧也没有通用 HTTP 命令
- 新增 `npm run typecheck:plugins`（`tsconfig.plugins.json`）：`plugins/` 下的入口
  之前**完全没被类型检查过**（根 `tsconfig.json` 只 include `src`）

### Removed

- **翻译插件的截屏取字（OCR）整条移除**（插件 v2.1.0 → **v2.2.0**）
  - 插件侧：删掉「截屏取字」按钮、`grabScreen`、OCR 结果重排（`ocrToText` /
    `joinLineParts` / `box*` / `recognize`，约 120 行）、以及 manifest 里
    `translate_grab` / `ocr_recognize` / `ocr_is_ready` 三条命令声明
  - 宿主侧：删掉 `src-tauri/src/plugins/translate_grab/`（`translate_grab` /
    `translate_grab_image` / `translate_grab_submit` 三条命令）、
    `src/components/TranslateCaptureWindow.tsx`、`main.tsx` 里的
    `#/translate-capture` 路由、capabilities 里的 `translate-capture` 窗口
  - 自检里对应的 `translate_grab` 两段也一起去掉（只留 HUD）
  - **独立的截图插件不受影响**：`src/plugins/screenshot/`、`ocr_*` 命令、
    `screenshot_*` 命令、`screenshot-overlay` 窗口全部原样保留 ——
    它自己的「截图 + 识别文字」照常可用

### Changed

- **`translate` 不再是内置插件**：`src/plugins/translate/` 已删除，`src/plugins/index.ts`
  不再注册它 —— 不腾出这个 id，外部插件会因重名被跳过。设置面板里的小牛配置区保留，
  传输层搬到 `core/niutrans-bridge.ts`（和插件写同一份存储）

- **工具区显示名改短**：`plugins/netdisk` → 「夸克网盘」（原「网盘下载」）、
  `plugins/api-probe` → 「API」（原「API 测活」）
  - 只动**显示名**（`manifest.json` 与插件源码里的 `name`）。插件 id 与目录仍是
    `netdisk` / `api-probe`，所以 `%APPDATA%` 下的插件目录不用重建，
    `ToolSection` 里按 id 硬连的那两处（`netdisk_app_launch` / `apiprobe_app_launch`）也不受影响
  - 网盘下载插件 1.2.0 → **1.2.1**、API 插件 1.0.0 → **1.0.1**；
    `src/__tests__/` 里加了钉住这两个显示名的用例，防止"两边只改一处"

### Fixed

- **点 DeepSeek 图标整个应用卡死**（`app.log` 停在 `[HUD] 打开 DeepSeek` 之后，再无输出）：
  建窗时多做了一步 `restore_state` —— 它会拿 `tauri-plugin-window-state` 的两把锁
  （`RestoringWindowState` / `WindowStateCache`），并且在持锁期间调
  `available_monitors()` / `set_size()`，这两个都要回调主线程；同时命令还在
  worker 线程上查主窗口几何（`outer_position` / `outer_size` / `scale_factor`）。
  叠在一起把主线程锁死，整个窗口失去响应
  - 现在收敛成仓库里**已验证可用**的写法（`plugins::translate_grab` 同样是
    async 命令 + 建窗 + show，实测 3 秒内成功）：
    不碰 `restore_state`、不做任何跨线程窗口查询（位置改由前端把
    `screenX/screenY/outerWidth/outerHeight` 传进来，Rust 只做纯数学）、
    先 `visible(false)` 建好再 `show()`、去掉 `min_inner_size`
  - 补了排查日志：`[HUD] ①开始建窗 / ②建窗完成 Xms / ③已显示`，
    外加 6 秒看门狗 —— 万一再卡，日志会直接指明"卡在
    `WebviewWindowBuilder::build()`"
  - 新增 debug-only 自检（`src-tauri/src/selftest.rs`，release 构建不编译）：
    `INFOBOARD_SELFTEST=1 cargo run` 会把 HUD 建窗和取字窗口复用**真跑一遍**再退出。
    实测：HUD 建窗 **73ms**、窗口 `visible=true`、URL 落在
    `https://chat.deepseek.com/sign_in`；取字窗口冷启动 3337ms → 复用后 **300ms**
- **`cargo test` 编译不过**（``AppSpec`` doesn't implement `Debug`）：
  `plugins/companion` 的测试对 `Result<_, String>` 调 `unwrap_err()`，而
  `core/companion.rs` 的 `AppSpec` 没派生 `Debug` —— 整个 lib test 目标都起不来，
  连带 `pack` / `secrets` / `ocr` / `webtranslate` 的用例全部跑不了
  - 给 `AppSpec` 补 `#[derive(Debug, Clone, Copy, PartialEq, Eq)]`（字段全是
    `&'static str`，本来就是编译期常量）
  - 现在 `cargo test --lib` **89 项全绿**


- **网盘下载器点「解析」必崩，任何分享链接都解析不了**
  （`解析失败: TypeError: 'ShareCtx' object is not subscriptable`）：
  `ShareCtx` 只有 `__setitem__`、没有 `__getitem__`，于是适配器里
  `ctx["pwd_id"] = ...`（写）正常，`ctx["stoken"]`（读）直接抛 TypeError ——
  而且是**解析的第一步**就读，所以链接好坏都一样崩
  - 修法：给 `ShareCtx` 补上对称的 `__getitem__` / `__contains__`
  - **为什么之前测不出来**：`tools/smoke_download.py` 只测下载引擎，
    `parse` / `list_dir` / `resolve` 一个都不经过；协议部分一直只在真链接上手工验过
  - 新增 `netdisk-app/tools/smoke_adapter.py`：离线喂**真实形状**的假响应
    （不发任何请求、不需要账号），把 `parse → list_dir → resolve` 整条链盖住，
    含 41006 / 41008 / 23018 / 401 / 坏链接等提示的断言
  - 顺带修 `smoke_download.py` 的收尾打印：GBK 控制台下 `print("全部通过 ✅")` 每次都抛
    `UnicodeEncodeError`，**把"全部通过"变成了退出码 1** —— 自测脚本自己把结论弄反了
  - `tools/*.py` 与 `main.py` 一样设 `sys.dont_write_bytecode = True`，
    跑自测不再往源码树里留 `__pycache__`

## [0.7.0] - 2026-10-19

### Added

- **API 测活插件**（`plugins/api-probe/`）：工具区一个图标，拉起独立的
  「API 中转站测活工具」（`api_probe.py`，tkinter GUI、零第三方依赖；
  站点与多 Key 管理 / 模型列表探测 / 批量测速与流畅度 / 一键接入 Claude Code 与 Codex）
  - 它**不随应用打包**（有自己的仓库、自己在迭代），所以第一次点会展开面板让你指定
    一次 `api_probe.py` 的位置，之后记住；配好之后再点图标就是直接开
  - 图标用宿主注册表里的 Lucide `activity`（脉冲折线），与截图/设置/翻译/网盘下载
    一样是具名线性图标，不用 emoji
- **宿主新增"伴随程序"设施**（`src-tauri/src/core/companion.rs`）：把"找一个外部
  Python 程序并把它拉起来"的逻辑抽出来给多个插件共用（找解释器、找入口脚本、
  记住用户指定的路径），网盘下载器也改用它
  - **刻意不做"通用启动命令"**：每个程序一组命令（`netdisk_app_launch` /
    `apiprobe_app_launch`），插件只能启动自己那一个，借不了道去启动别的
  - 手动指定路径时校验**入口文件名**（必须是 `api_probe.py`），
    免得这个能力被当成"启动任意程序"的口子

### Changed

- `plugins/netdisk/app.rs` 瘦成两个薄封装，逻辑走 `core::companion`

## [0.6.0] - 2026-10-18

本次新增一条完整的下载链路：**独立软件「网盘下载器」+ InfoBoard 里的一键启动入口**。

### Added

- **网盘下载器（独立软件）** —— `netdisk-app/`，Python + Tkinter，**只用标准库、不需要 pip**
  - 自己的窗口和进程：下载不再依赖 InfoBoard 面板是否开着。这一点是硬需求 ——
    插件跑在 WebView 里只在面板打开时运行，而网盘直链只有 5~10 分钟有效期，
    面板一关就没人换链，大文件必然下不完
  - 功能：解析分享 → 目录浏览（双击进入 / 返回上级）→ 多选或整目录**递归**下载 →
    队列显示进度/速度/状态，可取消、双击打开所在文件夹；设置里可改保存目录、
    并发连接数、夸克登录态（带"关键项齐全"体检）
  - 引擎：Range 探测 → **动态分片队列 + 抢占式取片**（片数 = 连接数 × 32、单片 ≥ 256KB）
    → 各线程用自己的文件句柄随机写同一文件；**直链过期自愈**（撞上 401/403/404/412
    就重新解析分享、从未完成的分片继续，最多 5 次）；**429/503 全局退避**
    （首次 30 秒、翻倍、上限 5 分钟）；**慢分片抢占**（15 秒无数据就换条连接）
  - 换链做了**串行化**：直链一过期所有线程会同时撞上 401/403/412，各换各的会瞬间
    耗尽重试预算、还会重复解析分享；用"代次"判断，只有第一个发现的线程真正去换
  - **只实现夸克**（按要求）。蓝奏云/百度等未接入，原因见 `docs/NETDISK.md`
  - 自测工具：`tools/smoke_download.py`（本地 HTTP 服务真跑分片下载并逐字节比对、
    过期换链续传、不支持 Range 退回单连接，**不需要账号**）、
    `tools/probe_quark.py`（打真实接口验证路径与错误码层次）
- **插件改成纯启动器**：工具区点「☁️ 网盘下载」直接把独立软件拉起来，**不展开中间面板**
  （与截图插件同一套做法）。启动失败会弹原生错误框说明原因（最常见：本机没装 Python）
- **宿主新增 `netdisk_app_status` / `netdisk_app_launch`**：在固定位置找
  `netdisk-app/main.py`（资源目录 → 可执行文件上级 → 当前目录），用不弹黑框的解释器
  （`pythonw` → `python` → `pyw` → `py`）拉起。**刻意不给插件开放"启动任意程序"的能力**
  —— 插件只能触发"启动它"，不能指定启动什么。打包时把 `netdisk-app/` 作为资源带上
- 新增 `dialog:allow-message` 能力（启动失败要弹框，只在控制台打印等于没说）
- `docs/NETDISK.md`：设计、协议序列、并发实测数据、排错与调研来源

### Changed

- **插件的权限大幅收紧**：`tauriCommands` 从 13 个降到 **2 个**
  （只剩 `netdisk_app_status` / `netdisk_app_launch`）—— 这个插件再也拿不到
  HTTP 转发、Cookie 读写、写文件这些能力。入口体积 55KB → 4KB，包 23.3KB → 2.4KB
- **`tsconfig` 补上 `@/*` 路径映射**：插件文档让作者写
  `import type ... from '@/core/types'`，但没有这个映射时，只要有测试从 `src` 里
  import 了插件，`npm run build` 就会 TS2307 失败。补上后插件也一并被类型检查

### Notes

- 关于"免费高速"，要区分**按连接限速**和**账号级限速**：
  夸克属于前者（单连接常态 100~200KB/s，**多连接可叠加**，实测 512 并发 × 256KB
  可达 21~23.7 MB/s；但存在账号级总量天花板，512 → 1024 连接几乎不再涨）；
  百度属于后者（20~80KB/s，实测 4/8/16 并发总量不变），客户端无解，只有 SVIP 能提速。
  伪 SVIP User-Agent 一类"破解"手法已被官方封堵，本软件不做也不建议做。
- 夸克匿名档只能下约 50MB 以下的文件（超了报 `23018`），且**加并发无效**（按整体限速）；
  登录后同一路径可直接下 GB 级文件并能靠并发提速。

## [0.5.0] - 2026-10-17

本次发布的两条主线：**插件包一键导入 / 卸载**，以及 **API Key 改存 Windows 凭据管理器**。

### Added

- **插件包导入 / 卸载**：设置 → 插件管理 支持把 `.ibplugin` 拖入虚线框安装，
  或走系统文件选择器；已安装列表带「卸载」按钮，同 id 覆盖安装即升级，
  全程不需要重启应用
  - Rust 侧新增 `install_plugin_package` / `list_installed_plugins` /
    `uninstall_plugin` / `purge_uninstalled_plugin`
  - 包内容按不可信输入处理：`enclosed_name()` 挡 zip slip、限制条目数与解压总量、
    `manifest.id` 白名单校验、解压到临时目录校验通过才原子改名（失败回滚）
  - 卸载分两步（先改名挪走，重新加载后再真删），规避 Windows 文件占用
- **插件打包脚本**：`node scripts/pack-plugin.mjs <插件目录>` → `dist-plugins/<id>-<version>.ibplugin`
  - 自带最小 zip 写入器（只用 Node 内置 zlib），不引第三方依赖
  - 与 Rust 侧双向格式契约测试（`include_bytes!` 读同一 fixture 真实安装一遍）
- **版本号单一来源校验**：`npm run version:check` / `version:sync`，
  以 `tauri.conf.json` 为准校验 `package.json` / `Cargo.toml`，并接入 pre-commit
- **凭据只读探针与跨重启回归测试**（`INFOBOARD_KEYRING_TEST=1` 开启）

### Changed

- **API Key 改存 Windows 凭据管理器**（服务名 `com.infoboard.tauri`，本机持久化）：
  和风天气 / 小牛翻译的 Key 不再明文写入 `localStorage` 或 `niutrans.json`；
  前端只写不读，拿不到明文；启动时自动迁移旧明文并清除
- **日志脱敏**：reqwest 错误经 `without_url()`，Key 只在发请求前由 Rust 用占位符注入
- **天气定时刷新改为仅窗口活跃时轮询**（原先隐藏到托盘后照跑）
- **主题色改用 React Context**，去掉渲染期改写模块级可变变量
- 全仓 prettier 规范化；修复此前**完全没生效**的 pre-commit 钩子
  （Husky 9 需要 `core.hooksPath` 指向 `.husky/_`，此前缺失）
- 版本号 `0.1.0` → `0.5.0`

### Fixed

- **B站信息补全失败被伪装成"没有结果"**：命令改 `Result<Option<..>, String>`，
  失败抛错并提示；失败不再写 30 分钟负缓存，改 60s 退避重试
- **截图拖拽时指针移出窗口松手会卡死**（永远停在 `selecting`）
- **`isEmoji` 判错**：`👋🏽` / `🏳️‍🌈` / `🇨🇳` 等组合 emoji 被判成非 emoji，
  两个汉字反被判成 emoji
- **错误信息渲染成 `[object Object]`**：新增统一格式化
- **标题栏最大化状态乐观翻转**，改为回读真实状态
- **紫外线恒显示 `--`**：缺数据时显示「暂无」
- **`bilibiliCache` 只增不减**：加容量上限与淘汰策略
- **插件注册容错**：单个插件失败不再中断整批，`initPromise` 失败后可恢复
- **`useLocationSearch` 防抖定时器未清理**、**B站空标题参与匹配**、
  **OCR/B站字节截断 panic**、**设置读取零类型校验**、**副作用写在 `setState` updater 内**
- **拖拽监听随安装状态重建**导致丢事件

### Documentation

- 修正插件文档中与代码不符的说明：import 路径、`@tauri-apps/api/event` **已不可用**、
  `tauriCommands` 必须声明否则 invoke 被拒、重新加载而非重启
- 新增 `docs/release-notes-v0.5.0.md`、`REMAINING_ISSUES_STATUS.md`

## [0.4.0] - 2026-10-16

### Added

- **外部插件系统**: 支持热插拔插件，无需修改核心代码即可添加新功能
  - 新增 `PluginLoader` 类处理外部插件动态加载
  - 新增 Rust 侧 `scan_external_plugins` 命令扫描 `plugins/` 目录
  - 新增 `ExternalPluginMeta` 类型定义插件元数据
  - 扩展 `PluginManifest` 支持版本、作者、描述字段
  - `InfoBoardPlugin` 新增 `type` 和 `sourcePath` 字段区分内置/外部插件

- **插件开发工具**: 完整的外部插件开发支持
  - 新增 `docs/PLUGIN_TUTORIAL.md` 插件开发教程
  - 新增 `plugins/hello-world/` 示例插件
  - 新增 `reloadPluginSystem()` 方法支持插件热重载

- **API 增强**:
  - `PluginRegistry` 新增别名方法: `get()`, `getAll()`, `getBySection()`
  - `core/index.ts` 导出 `PluginLoader` 和 `reloadPluginSystem`

### Changed

- **PluginHost 重构**: 拆分内置插件和外部插件加载逻辑
  - `importPlugins()` 拆分为 `importBuiltinPlugins()` 和 `importExternalPlugins()`
  - 内置插件自动标记 `type: 'builtin'`
  - 外部插件自动标记 `type: 'external'`

- **项目结构调整**:
  - `src/plugins/` → 内置插件目录
  - 新增 `plugins/` → 外部插件目录
  - `src-tauri/src/plugins/` 新增 `loader.rs` 模块

### Documentation

- 更新 `README.md` 添加外部插件系统说明和快速开始
- 更新项目结构文档包含 `plugins/` 目录

## [之前版本]

请参考 Git 提交历史
