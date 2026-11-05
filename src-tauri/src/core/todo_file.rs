//! 待办数据落盘层：`<data dir>/todo.json`
//!
//! 为什么要这一层：待办原先只存在前端的 localStorage 里，换个 webview（独立待办窗口、
//! 清缓存、重装）就丢，命令行也没法读写。这里把待办落到一个**人和程序都能读**的 JSON
//! 文件，前端通过 Tauri 命令访问，`infoboard-todo` CLI 直接复用同一套代码。
//!
//! 文件形状（严格，前端 `src/plugins/todo/types.ts` 的 `Todo` 一一对应）：
//! ```json
//! { "version": 1, "rev": 7, "todos": [ { "id": "...", "text": "...", "completed": false,
//!   "deadline": "2027-01-05", "deadlineTs": 1799164799999, "createdAt": 1793704798810 } ] }
//! ```
//!
//! 三条硬规则：
//! 1. **文件不存在** → 空列表、`rev = 0`（不是错误）；
//! 2. **文件损坏** → 返回 `Err(Corrupt)`，**绝不覆盖**（用户数据只能人工抢救）；
//! 3. **写入原子** → 先写 `todo.json.tmp`，再 `fs::rename` 覆盖（Windows 上 std 的
//!    rename 走 `MoveFileEx(MOVEFILE_REPLACE_EXISTING)`，可以覆盖已存在文件），
//!    写完 `rev += 1`。
//!
//! 读入的宽容度（"损坏"只指真的读不出待办，不指"形状和我们想象的不完全一样"）：
//! - `version` / `rev` 缺省 → 0 / `FILE_VERSION`；单条缺 `completed` / `createdAt`
//!   → `false` / `0`（早期版本、手写文件都可能缺）；
//! - 裸数组（老 `localStorage['todo-list']` 的形状）→ 当成 `rev = 0` 的整表；
//! - 空白 / 0 字节文件 → 视作"还没有待办"（创建了还没写、写到一半掉电），不是损坏；
//! - **仍然算损坏**：非 UTF-8 二进制、截断的 JSON、`todos` 类型不对、缺 `id` / `text`
//!   —— 这些补不出来，猜就是毁数据。

use chrono::{DateTime, Datelike, Local, NaiveDate, TimeZone};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::path::{Path, PathBuf};

/// 覆盖数据目录的环境变量（测试 + CLI 冒烟 + 绿色版都用它）
pub const DATA_DIR_ENV: &str = "INFOBOARD_DATA_DIR";

/// 数据文件名
pub const TODO_FILE_NAME: &str = "todo.json";

/// 当前文件格式版本
pub const FILE_VERSION: u64 = 1;

/// Windows 下的数据目录名 = Tauri 的 `app_data_dir()`。
///
/// **为什么写死常量而不是用 AppHandle**：`infoboard-todo` CLI 没有 Tauri 运行时，
/// 拿不到 `AppHandle`；而数据层必须被 CLI 和 Tauri 命令共用（否则两边路径分叉，
/// CLI 改的待办 app 看不见）。已核实 `identifier = "com.infoboard.tauri"`
/// （`src-tauri/tauri.conf.json`），Windows 上 `app_data_dir()` 就是
/// `%APPDATA%\com.infoboard.tauri`，与此处一致。改 identifier 时必须同步改这里。
pub const APP_DATA_DIR_NAME: &str = "com.infoboard.tauri";

// ─────────────────────────── 数据类型 ───────────────────────────

/// 单条待办 —— 字段与前端 `Todo` 完全对齐（`deadlineTs` / `createdAt` 是 camelCase）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoItem {
    /// 唯一标识 —— **必填**，缺了没法自动补（补一个假 id 等于制造重复条目），
    /// 缺了就是损坏
    pub id: String,
    /// 待办内容 —— 同样**必填**
    pub text: String,
    /// 是否完成。缺省 `false`：早期版本 / 手写文件不写这个键，语义上就是"未完成"
    #[serde(default)]
    pub completed: bool,
    /// 截止日期原文（ISO `YYYY-MM-DD`，或旧版自由文本）；无边截止时间时不写这个键
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deadline: Option<String>,
    /// 截止时间戳（毫秒，本地时区当天 23:59:59.999），从 `deadline` 派生，用于排序
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deadline_ts: Option<i64>,
    /// 创建时间戳（毫秒）。缺省 `0`：旧数据没有这个字段，排序时它会沉到"无截止时间"
    /// 那一组的末尾；给个"现在"反而会打乱用户熟悉的顺序，也不可复现
    #[serde(default)]
    pub created_at: i64,
}

fn default_version() -> u64 {
    FILE_VERSION
}

/// `todo.json` 的顶层结构
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoFile {
    /// 文件格式版本：缺省按当前版本算
    ///
    /// **兼容早期版本 / 手写文件**：真机上存在过 17 字节的 `{"todos": []}`（2026-07-08
    /// 生成，没有 `version` / `rev`），严格解析会 `missing field version` → 整个 app 进
    /// "数据损坏、只读"态，而那份文件里其实什么数据都没有。
    #[serde(default = "default_version")]
    pub version: u64,
    /// 修订号：缺省按 0 算（= "谁也没写过"），等价于文件不存在
    #[serde(default)]
    pub rev: u64,
    /// 待办列表 —— **必填**。`{"todos": "x"}` / `{}` 仍然必须是损坏：
    /// 少了这个键时"是不是空表"无法判断，猜成空表等于把整表当垃圾扔掉
    pub todos: Vec<TodoItem>,
}

impl TodoFile {
    /// 文件不存在时的等价物：空列表、rev 0
    pub fn empty() -> Self {
        Self { version: FILE_VERSION, rev: 0, todos: Vec::new() }
    }
}

/// `todo_snapshot` 的返回体（前端按这个接）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoSnapshot {
    pub rev: u64,
    pub todos: Vec<TodoItem>,
}

// ─────────────────────────── 错误 ───────────────────────────

/// 数据层错误：把"文件坏了"和"IO 出错"分开，好让 CLI 给出不同退出码
/// （损坏 = 3，其它 = 1），前端也能据此决定"备份原文还是提示重试"。
#[derive(Debug, Clone, PartialEq)]
pub enum TodoError {
    /// JSON 解析失败 / 结构不符 —— 调用方**绝不能**覆盖文件
    Corrupt(String),
    /// 读写失败
    Io(String),
}

impl TodoError {
    pub fn is_corrupt(&self) -> bool {
        matches!(self, TodoError::Corrupt(_))
    }
}

impl fmt::Display for TodoError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TodoError::Corrupt(msg) => write!(f, "待办数据损坏：{msg}"),
            TodoError::Io(msg) => write!(f, "{msg}"),
        }
    }
}

impl std::error::Error for TodoError {}

// ─────────────────────────── 路径 ───────────────────────────

/// 数据目录：`INFOBOARD_DATA_DIR` 优先，否则 Windows `%APPDATA%\com.infoboard.tauri`
pub fn data_dir() -> Result<PathBuf, TodoError> {
    if let Some(dir) = std::env::var_os(DATA_DIR_ENV) {
        let path = PathBuf::from(dir);
        if !path.as_os_str().is_empty() {
            return Ok(path);
        }
    }

    #[cfg(windows)]
    {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            if !appdata.is_empty() {
                return Ok(PathBuf::from(appdata).join(APP_DATA_DIR_NAME));
            }
        }
        Err(TodoError::Io(format!(
            "无法定位数据目录：环境变量 APPDATA 缺失（可用 {DATA_DIR_ENV} 指定）"
        )))
    }

    #[cfg(not(windows))]
    {
        if let Some(xdg) = std::env::var_os("XDG_DATA_HOME") {
            if !xdg.is_empty() {
                return Ok(PathBuf::from(xdg).join(APP_DATA_DIR_NAME));
            }
        }
        if let Some(home) = std::env::var_os("HOME") {
            if !home.is_empty() {
                return Ok(PathBuf::from(home).join(".local/share").join(APP_DATA_DIR_NAME));
            }
        }
        Err(TodoError::Io(format!(
            "无法定位数据目录：HOME 缺失（可用 {DATA_DIR_ENV} 指定）"
        )))
    }
}

/// 给定目录下的 todo.json 路径
pub fn todo_path_in(dir: &Path) -> PathBuf {
    dir.join(TODO_FILE_NAME)
}

/// 真实数据文件路径
pub fn todo_path() -> Result<PathBuf, TodoError> {
    Ok(todo_path_in(&data_dir()?))
}

// ─────────────────────────── 读 ───────────────────────────

/// 读指定路径的 todo.json；不存在 / 空白 → 空文件结构（rev 0），损坏 → `Err(Corrupt)`
pub fn load_at(path: &Path) -> Result<TodoFile, TodoError> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(TodoFile::empty()),
        Err(err) => {
            return Err(TodoError::Io(format!("读取 {} 失败：{err}", path.display())));
        }
    };
    // 非 UTF-8 同样算损坏（不是"没有数据"），避免把二进制垃圾当空列表覆盖掉
    let raw = String::from_utf8(bytes)
        .map_err(|_| TodoError::Corrupt(format!("{} 不是合法 UTF-8 文本", path.display())))?;
    parse_file(&raw, path)
}

fn parse_file(raw: &str, path: &Path) -> Result<TodoFile, TodoError> {
    // Windows 记事本可能写 BOM；JSON 解析器不认，先剥掉
    let text = raw.trim_start_matches('\u{feff}');
    // 空白 / 0 字节 = "还没写"，不是"写坏了"：内容本来就没了，锁成只读只会
    // 挡住后续所有写入（一条数据都没保住，还让用户没法用）。按"文件不存在"处理。
    // 注意：非 UTF-8 已在 `load_at` 里拦成 Corrupt，这里放宽只针对合法 UTF-8 的空白。
    if text.trim().is_empty() {
        return Ok(TodoFile::empty());
    }
    // 先按正式形状解析
    let object_err = match serde_json::from_str::<TodoFile>(text) {
        Ok(file) => return Ok(file),
        Err(err) => err,
    };
    // 再试"裸数组"：老 `localStorage['todo-list']` 就是这个形状，用户/脚本手工拷一份
    // 成 todo.json 很自然。数组没有 rev 的概念 → 视作 rev 0（= 从没人写过，仍允许迁移）。
    match serde_json::from_str::<Vec<TodoItem>>(text) {
        Ok(todos) => Ok(TodoFile { version: FILE_VERSION, rev: 0, todos }),
        // 两条路都失败 → 真损坏；文案带上对象的原始报错（数组那条通常更没信息量）
        Err(_) => Err(TodoError::Corrupt(format!(
            "{} 解析失败：{object_err}",
            path.display()
        ))),
    }
}

/// 读真实数据文件
pub fn load() -> Result<TodoFile, TodoError> {
    load_at(&todo_path()?)
}

// ─────────────────────────── 写 ───────────────────────────

/// 覆盖写指定路径：**写前重读一次**拿最新 rev（避免覆盖别人刚写的），rev 自增
///
/// 注意：重读只用来对齐 rev，不会合并别人的改动 —— 同一毫秒内的并发写仍是
/// 后写者赢（前端是单窗口权威写者，CLI 是人工操作，这个粒度足够）。
pub fn save_at(path: &Path, todos: Vec<TodoItem>) -> Result<u64, TodoError> {
    // 损坏时返回 Err ← 这里就是"绝不覆盖损坏文件"的落点
    let current = load_at(path)?;
    let rev = current.rev.saturating_add(1);
    write_at(path, rev, &todos)?;
    Ok(rev)
}

/// 覆盖写真实数据文件
pub fn save(todos: Vec<TodoItem>) -> Result<u64, TodoError> {
    save_at(&todo_path()?, todos)
}

/// 原子写：`todo.json.tmp` → rename 覆盖
fn write_at(path: &Path, rev: u64, todos: &[TodoItem]) -> Result<(), TodoError> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|err| {
                TodoError::Io(format!("创建数据目录 {} 失败：{err}", parent.display()))
            })?;
        }
    }

    let file = TodoFile { version: FILE_VERSION, rev, todos: todos.to_vec() };
    let mut json = serde_json::to_string_pretty(&file)
        .map_err(|err| TodoError::Io(format!("序列化待办失败：{err}")))?;
    json.push('\n');

    let tmp = tmp_path(path);
    std::fs::write(&tmp, json.as_bytes())
        .map_err(|err| TodoError::Io(format!("写入 {} 失败：{err}", tmp.display())))?;
    if let Err(err) = std::fs::rename(&tmp, path) {
        // 失败时别把 tmp 留在磁盘上（下次写入会覆盖，但残留容易误导人）
        let _ = std::fs::remove_file(&tmp);
        return Err(TodoError::Io(format!("替换 {} 失败：{err}", path.display())));
    }
    Ok(())
}

/// `xxx.json` → `xxx.json.tmp`（同目录，保证 rename 不跨卷）
fn tmp_path(path: &Path) -> PathBuf {
    let mut os = path.as_os_str().to_owned();
    os.push(".tmp");
    PathBuf::from(os)
}

// ─────────────────────────── 声明式同步（apply） ───────────────────────────
//
// 为什么要有它：`add` 每次生成随机 id，脚本反复把同一批外部条目同步进来就会堆重复
// 条目；而且"这条在来源里已经消失了"没有任何表达方式。
// `apply` 换个方向：**给一份完整清单，把 todo.json 对齐成清单的样子**。
//
// - 幂等靠 `id`：同 id 走更新，不新增；同样的清单跑 N 次结果一样，rev 只涨一次；
// - 清理由调用方显式授权：只删"id 命中 `prune_prefixes` 前缀 **且** 这次清单没给"的
//   条目；前缀为空 = 一条都不删（默认绝不删数据）。
//
// 它**不是**通用 diff 工具：不动 `createdAt`、不接受把 `completed` 从 true 改回 false。

/// `apply` 的单条输入（外部来源 / 脚本给的清单项，字段名 camelCase = 前端口径）
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyItem {
    /// 稳定 id（同一个来源条目每次同步都必须是同一个值，否则"幂等"无从谈起）
    pub id: String,
    pub text: String,
    /// "YYYY-MM-DD" 或 "M月D日"，落盘时归一化成 ISO；缺省 / 空串 = 没有截止时间
    #[serde(default)]
    pub deadline: Option<String>,
    #[serde(default)]
    pub completed: bool,
}

/// `apply` 的结果（计数 + 落盘后的 rev）
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyReport {
    /// 有变化 → 写盘后的新 rev；无变化 / dry-run → 当前 rev
    pub rev: u64,
    pub added: usize,
    pub updated: usize,
    pub removed: usize,
    pub unchanged: usize,
    pub dry_run: bool,
}

/// 声明式同步：把 `path` 处的待办对齐成 `items`（幂等 upsert + 前缀 prune）
///
/// 逐条规则：
/// 1. 先校验输入：`id` / `text` trim 后为空、或 `items` 里出现重复 id → `Err`，
///    一个字节都不写（错误用 `Corrupt`，因为错误枚举不该为"调用方传错了"再加一个新变体；
///    文案里会写清是**输入**问题，不是文件问题）；
/// 2. `load_at` 先读：文件不存在 → 空表；损坏 → `Err(Corrupt)`，绝不覆盖；
/// 3. 同 id 存在 → 比 `text` 与归一化后的 `deadline`，不同就是"更新"（保留原 `createdAt`），
///    相同就是"未变"；`completed` 只允许 false → true（`existing || item`），
///    这个合并本身不计入 `updated`；
/// 4. prune：`id` 命中任一前缀 **且** 不在本次 `items` 里 → 删除，计入 `removed`；
///    `prune_prefixes` 为空 → 一条都不删；
/// 5. 真的什么都没变 → **不写盘**，rev 不变；
/// 6. 有变化 → 一次 `write_at(rev + 1)`，rev 只 +1；
/// 7. `dry_run` → 只算报告，不写盘，`rev` 返回当前值；
/// 8. 落盘顺序：**已有条目保持文件里的原顺序，新增条目按 `items` 顺序追加在后**
///    （顺序对 app 无意义 —— 视图自己按 `compare_todos` 排序，这里只为可复现）。
pub fn apply_at(
    path: &Path,
    items: &[ApplyItem],
    prune_prefixes: &[String],
    dry_run: bool,
) -> Result<ApplyReport, TodoError> {
    apply_with_now(path, items, prune_prefixes, dry_run, Local::now(), now_ms())
}

/// `apply_at` 的实现体：`now` / `now_ms` 作为参数注入，保证单测可复现
/// （`M月D日` 的年份、新增条目的 `createdAt` 都跟它们有关）
fn apply_with_now(
    path: &Path,
    items: &[ApplyItem],
    prune_prefixes: &[String],
    dry_run: bool,
    now: DateTime<Local>,
    now_ms: i64,
) -> Result<ApplyReport, TodoError> {
    // ── 1. 输入校验：id / text 不能空，id 不能重复 ──
    // 空 text 不许静默跳过：跳过等于"假装同步成功"，来源那边的问题永远暴露不出来
    let mut seen_ids: HashSet<&str> = HashSet::with_capacity(items.len());
    for item in items {
        let id = item.id.trim();
        if id.is_empty() || item.text.trim().is_empty() {
            return Err(TodoError::Corrupt(format!(
                "items 里有条目的 id / text 是空白（id = {:?}）：这是调用方给的数据有问题，不是 todo.json 损坏",
                item.id
            )));
        }
        if !seen_ids.insert(id) {
            return Err(TodoError::Corrupt(format!(
                "items 里有重复 id：{id}\n（同一条不该出现两次：更新谁、不更新谁无法判断，整批不写）"
            )));
        }
    }

    // ── 2. 先把 deadline 全部解析完 ──
    // 任何一条非法都整批不写：半批写进去比不写更难收拾
    let mut normalized: Vec<(Option<String>, Option<i64>)> = Vec::with_capacity(items.len());
    for item in items {
        let slot = match item.deadline.as_deref() {
            // 缺键 / 空串都当"没有截止时间"：外部来源常用 "" 表示无期限，
            // 为它让整批失败太苛刻（而且语义上没有歧义）
            None => (None, None),
            Some(raw) if raw.trim().is_empty() => (None, None),
            Some(raw) => match normalize_deadline(raw, now) {
                Some((text, ts)) => (Some(text), Some(ts)),
                None => {
                    return Err(TodoError::Corrupt(format!(
                        "无法识别的截止日期：{raw}\n（支持 `YYYY-MM-DD` 或 `M月D日`；整批未写入）"
                    )));
                }
            },
        };
        normalized.push(slot);
    }

    // ── 3. 读现状（损坏原样透出，绝不覆盖） ──
    let current = load_at(path)?;

    // id → items 下标（ids 已校验过唯一）
    let mut item_index: HashMap<&str, usize> = HashMap::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        item_index.insert(item.id.trim(), index);
    }
    // 空前缀会命中一切 —— 手抖写个 `--prune ""` 不该等于清库，直接忽略
    let prefixes: Vec<&str> = prune_prefixes
        .iter()
        .map(|prefix| prefix.trim())
        .filter(|prefix| !prefix.is_empty())
        .collect();

    let mut next: Vec<TodoItem> = Vec::with_capacity(current.todos.len() + items.len());
    let mut found = vec![false; items.len()];
    let mut added = 0usize;
    let mut updated = 0usize;
    let mut removed = 0usize;
    let mut unchanged = 0usize;
    // `dirty` = 落盘内容真的会变（含 completed 合并那种"不算 updated 但要落盘"的情况）
    let mut dirty = false;

    // ── 4. 已有条目：原地合并 / 保留 / prune，保持文件里的原顺序 ──
    for existing in &current.todos {
        let key = existing.id.trim();
        match item_index.get(key) {
            Some(&index) => {
                found[index] = true;
                let item = &items[index];
                let (deadline, deadline_ts) = normalized[index].clone();
                let text = item.text.trim();

                let content_changed = existing.text != text || existing.deadline != deadline;
                // 只允许 true 覆盖 false：来源说"没完成"不代表用户没在 app 里勾掉它
                let merged_completed = existing.completed || item.completed;
                let completed_changed = merged_completed != existing.completed;

                if content_changed {
                    updated += 1;
                } else {
                    unchanged += 1;
                }

                if content_changed || completed_changed {
                    dirty = true;
                    let mut merged = existing.clone();
                    if content_changed {
                        merged.text = text.to_string();
                        merged.deadline = deadline;
                        merged.deadline_ts = deadline_ts;
                    }
                    merged.completed = merged_completed;
                    next.push(merged);
                } else {
                    next.push(existing.clone());
                }
            }
            None => {
                if prefixes.iter().any(|prefix| key.starts_with(prefix)) {
                    removed += 1;
                    dirty = true;
                } else {
                    next.push(existing.clone());
                }
            }
        }
    }

    // ── 5. 新增：追加在后面，`createdAt` 取现在 ──
    for (index, item) in items.iter().enumerate() {
        if found[index] {
            continue;
        }
        let (deadline, deadline_ts) = normalized[index].clone();
        next.push(TodoItem {
            id: item.id.trim().to_string(),
            text: item.text.trim().to_string(),
            completed: item.completed,
            deadline,
            deadline_ts,
            created_at: now_ms,
        });
        added += 1;
        dirty = true;
    }

    // ── 6. dry-run / 无变化：不写盘，rev 原样返回 ──
    if dry_run || !dirty {
        return Ok(ApplyReport {
            rev: current.rev,
            added,
            updated,
            removed,
            unchanged,
            dry_run,
        });
    }

    // ── 7. 有变化：一次原子写，rev 只 +1 ──
    // 直接用 current.rev（上面 load_at 读到的），不再调 save_at 重读一遍：
    // 这次写入的基线就是那份数据，重读只会让 rev 与校验过的内容是两次不同的快照。
    let rev = current.rev.saturating_add(1);
    write_at(path, rev, &next)?;
    Ok(ApplyReport { rev, added, updated, removed, unchanged, dry_run: false })
}

// ─────────────────────────── 旧数据迁移 ───────────────────────────

/// 迁移旧 localStorage 数据：只写"没有内容会被覆盖"的位置
///
/// 允许写入的两种情况：
/// 1. `todo.json` 不存在；
/// 2. 存在但是**空壳**（能读出来、`rev == 0`、`todos` 为空）—— 例如真机上那份 17 字节的
///    `{"todos": []}`。它里面一条待办都没有，不存在"被覆盖"的东西；如果还按"存在就不导入"
///    处理，用户的真实待办（只活在 localStorage 里）就**永远**迁不过来。
///
/// 绝不写入的情况：`rev > 0` 或 `todos` 非空（哪怕只有一条），以及文件损坏。
///
/// - `Ok(Some(rev))`：已导入，rev 为新文件的版本号（恒为 1）
/// - `Ok(None)`：文件里已有数据，或 `raw` 为空 —— 什么都没做
/// - `Err(Corrupt)`：文件损坏（原封不动返回，不写任何东西），或 `raw` 解析失败
///   —— 让前端去备份原文
pub fn import_legacy_at(path: &Path, raw: &str) -> Result<Option<u64>, TodoError> {
    // 损坏必须原样透出：调用方据此进"只读 + 备份"分支
    let existing = load_at(path)?;
    if existing.rev > 0 || !existing.todos.is_empty() {
        return Ok(None);
    }
    let text = raw.trim_start_matches('\u{feff}');
    if text.trim().is_empty() {
        // 前端 localStorage 里根本没有待办（status = empty）：无事可做，不落空文件
        return Ok(None);
    }
    let todos: Vec<TodoItem> = serde_json::from_str(text).map_err(|err| {
        TodoError::Corrupt(format!("旧版待办数据（localStorage 数组）解析失败：{err}"))
    })?;
    // `raw == "[]"` 也照写不误：用户确实给了个（空）数组，rev 从 1 开始，
    // 语义是"迁移过了"，和 `Ok(None)`（"没东西可迁"）不是一回事
    write_at(path, 1, &todos)?;
    Ok(Some(1))
}

/// 迁移真实数据文件
pub fn import_legacy(raw: &str) -> Result<Option<u64>, TodoError> {
    import_legacy_at(&todo_path()?, raw)
}

// ─────────────────────────── 排序 ───────────────────────────

/// 与前端 `compareTodosByDeadline`（`src/plugins/todo/utils.ts`）等价的比较器
///
/// 1. 未完成在前，已完成沉底；
/// 2. 组内：有 `deadlineTs` 的按时间升序排前面；
/// 3. 都没有 `deadlineTs` 的按 `createdAt` **降序**（新建的在前）。
pub fn compare_todos(a: &TodoItem, b: &TodoItem) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    if a.completed != b.completed {
        return if a.completed { Ordering::Greater } else { Ordering::Less };
    }
    match (a.deadline_ts, b.deadline_ts) {
        (Some(x), Some(y)) => x.cmp(&y),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        // JS 的 Array.prototype.sort 是稳定排序，这里用 sort_by（稳定）保持一致
        (None, None) => b.created_at.cmp(&a.created_at),
    }
}

/// 按 app 的顺序返回一份新列表（**序号就是这里的下标 + 1**）
pub fn sorted(todos: &[TodoItem]) -> Vec<TodoItem> {
    let mut out = todos.to_vec();
    out.sort_by(compare_todos);
    out
}

// ─────────────────────────── 日期解析 ───────────────────────────
//
// 全部对齐前端 `src/plugins/todo/utils.ts`：
// `parseDeadlineToDayEnd` / `chineseDateToIso` / `parseDeadlinePatch`。
// `now` 一律作为参数注入，方便单测跨越年份，也避免"半夜跑测试"造成的偶发失败。

/// 本地时区"当天 23:59:59.999"的毫秒时间戳
///
/// 必须真正校验年月日：`2026-02-30`、平年 `2026-02-29` 一律返回 `None`
/// （前端用"构造后回读年月日比对"来拒绝 JS 的自动进位，这里用 `NaiveDate::from_ymd_opt`
/// 直接拒绝，等价且更直接）；年份 < 100 也返回 `None`，因为 JS 的
/// `new Date(5, ...)` 会跑成 1905 年、回读不一致 → 前端同样得到 `undefined`。
fn local_day_end(year: i32, month: u32, day: u32) -> Option<i64> {
    if year < 100 {
        return None;
    }
    let date = NaiveDate::from_ymd_opt(year, month, day)?;
    let naive = date.and_hms_milli_opt(23, 59, 59, 999)?;
    match Local.from_local_datetime(&naive) {
        chrono::LocalResult::Single(dt) => Some(dt.timestamp_millis()),
        // 夏令时/时区调整导致的边界：取更早的那个，绝不 panic
        chrono::LocalResult::Ambiguous(earlier, _) => Some(earlier.timestamp_millis()),
        chrono::LocalResult::None => None,
    }
}

/// 本地"今天 00:00:00.000"的毫秒时间戳
fn local_day_start(now: DateTime<Local>) -> i64 {
    let date = now.date_naive();
    match date.and_hms_opt(0, 0, 0) {
        Some(naive) => match Local.from_local_datetime(&naive) {
            chrono::LocalResult::Single(dt) => dt.timestamp_millis(),
            chrono::LocalResult::Ambiguous(earlier, _) => earlier.timestamp_millis(),
            // 极端时区把 0 点吞掉了：退化成"当前时刻"，最多让跨年判断差一天
            chrono::LocalResult::None => now.timestamp_millis(),
        },
        None => now.timestamp_millis(),
    }
}

/// `^(\d{4})-(\d{2})-(\d{2})$` 的严格版本（只认 ASCII 数字）
fn parse_iso_parts(text: &str) -> Option<(i32, u32, u32)> {
    let bytes = text.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let digits = |slice: &[u8]| -> Option<u32> {
        slice.iter().try_fold(0u32, |acc, b| {
            if b.is_ascii_digit() {
                Some(acc * 10 + u32::from(b - b'0'))
            } else {
                None
            }
        })
    };
    let year = digits(&bytes[0..4])? as i32;
    let month = digits(&bytes[5..7])?;
    let day = digits(&bytes[8..10])?;
    Some((year, month, day))
}

/// `^(\d{1,2})月(\d{1,2})日$` 的严格版本
fn parse_cn_parts(text: &str) -> Option<(u32, u32)> {
    let rest = text.strip_suffix('日')?;
    let (month, day) = rest.split_once('月')?;
    Some((parse_1_2_digits(month)?, parse_1_2_digits(day)?))
}

fn parse_1_2_digits(text: &str) -> Option<u32> {
    if text.is_empty() || text.len() > 2 || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse::<u32>().ok()
}

/// 中文日期该落在哪一年 —— "下一次出现"规则：今年这一天已过（早于今天 0 点）就用明年
fn cn_year(month: u32, day: u32, now: DateTime<Local>) -> i32 {
    let year = now.date_naive().year();
    match local_day_end(year, month, day) {
        Some(ts) if ts < local_day_start(now) => year + 1,
        _ => year,
    }
}

/// 截止日期 → 本地当天 23:59:59.999 的时间戳（解析不了返回 `None`）
///
/// - `YYYY-MM-DD`：严格按给定年份
/// - `M月D日`：按"下一次出现"规则定年
pub fn parse_deadline_to_day_end(text: &str, now: DateTime<Local>) -> Option<i64> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    if let Some((year, month, day)) = parse_iso_parts(text) {
        return local_day_end(year, month, day);
    }
    if let Some((month, day)) = parse_cn_parts(text) {
        let year = cn_year(month, day, now);
        return local_day_end(year, month, day);
    }
    None
}

/// `M月D日` → `YYYY-MM-DD`（按"下一次出现"规则定年）；无法解析返回 `None`
pub fn chinese_date_to_iso(text: &str, now: DateTime<Local>) -> Option<String> {
    let (month, day) = parse_cn_parts(text.trim())?;
    let year = cn_year(month, day, now);
    local_day_end(year, month, day)?;
    Some(format!("{year:04}-{month:02}-{day:02}"))
}

/// 用户输入 → 落盘的 `(deadline, deadlineTs)`
///
/// 与前端 `parseDeadlinePatch` 一致：中文日期归一化成 ISO（否则跨年的「1月5日」
/// 在界面上永远看不出是明年），ISO 原样保留；解析失败返回 `None`，调用方**不要写文件**。
pub fn normalize_deadline(text: &str, now: DateTime<Local>) -> Option<(String, i64)> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    let ts = parse_deadline_to_day_end(text, now)?;
    if parse_cn_parts(text).is_some() {
        let iso = chinese_date_to_iso(text, now)?;
        Some((iso, ts))
    } else {
        Some((text.to_string(), ts))
    }
}

/// 是否逾期：未完成 + 有截止时间戳 + 截止时刻已过（当天不算逾期）
pub fn is_overdue(todo: &TodoItem, now_ms: i64) -> bool {
    if todo.completed {
        return false;
    }
    match todo.deadline_ts {
        Some(ts) => ts < now_ms,
        None => false,
    }
}

// ─────────────────────────── 小工具 ───────────────────────────

/// 当前毫秒时间戳
pub fn now_ms() -> i64 {
    Local::now().timestamp_millis()
}

/// 生成 id：与前端 `generateId()` 同形（毫秒时间戳 36 进制 + 随机后缀，全是小写字母/数字）
pub fn new_id() -> String {
    let mut id = to_base36(now_ms().max(0) as u64);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| u64::from(d.subsec_nanos()))
        .unwrap_or(0);
    let mix = nanos
        .wrapping_mul(2_654_435_761)
        .wrapping_add(u64::from(std::process::id()));
    id.push_str(&to_base36(mix));
    id
}

fn to_base36(mut value: u64) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if value == 0 {
        return "0".to_string();
    }
    let mut out = Vec::new();
    while value > 0 {
        out.push(DIGITS[(value % 36) as usize]);
        value /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_else(|_| "0".to_string())
}

// ─────────────────────────── Tauri 命令 ───────────────────────────
//
// 名字和签名不许改：前端已按这四个接（`invoke('todo_snapshot')` 等）。

/// 读当前快照。`todos` 保持**文件里的顺序**（视图自己按 compare_todos 排序）
#[tauri::command]
pub fn todo_snapshot() -> Result<TodoSnapshot, String> {
    let file = load().map_err(|err| err.to_string())?;
    Ok(TodoSnapshot { rev: file.rev, todos: file.todos })
}

/// 整表覆盖写，返回新的 rev
#[tauri::command]
pub fn todo_commit(todos: Vec<TodoItem>) -> Result<u64, String> {
    save(todos).map_err(|err| err.to_string())
}

/// 迁移旧 localStorage 数据；文件里已有数据（`rev > 0` 或 `todos` 非空）时返回 `Ok(None)`
#[tauri::command]
pub fn todo_import_legacy(raw: String) -> Result<Option<u64>, String> {
    import_legacy(&raw).map_err(|err| err.to_string())
}

/// 数据文件路径（供"设置"页展示 / CLI 提示）
#[tauri::command]
pub fn todo_data_path() -> Result<String, String> {
    todo_path()
        .map(|path| path.to_string_lossy().to_string())
        .map_err(|err| err.to_string())
}

// ─────────────────────────── 单测 ───────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static DIR_SEQ: AtomicU64 = AtomicU64::new(0);

    /// 每次新建唯一临时目录（测试并行跑，不能共用目录）
    fn temp_dir(name: &str) -> PathBuf {
        let seq = DIR_SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "infoboard-todo-test-{name}-{}-{seq}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn at(year: i32, month: u32, day: u32) -> DateTime<Local> {
        Local
            .with_ymd_and_hms(year, month, day, 10, 30, 0)
            .single()
            .expect("固定本地时间应存在")
    }

    fn item(id: &str, text: &str, completed: bool, deadline: Option<(&str, i64)>, created_at: i64) -> TodoItem {
        TodoItem {
            id: id.to_string(),
            text: text.to_string(),
            completed,
            deadline: deadline.map(|(d, _)| d.to_string()),
            deadline_ts: deadline.map(|(_, ts)| ts),
            created_at,
        }
    }

    // ─── 1. 空目录 → 空列表、rev 0 ───

    #[test]
    fn missing_file_reads_as_empty() {
        let dir = temp_dir("empty");
        let path = todo_path_in(&dir);
        let file = load_at(&path).expect("不存在应视为空列表而不是错误");
        assert_eq!(file.rev, 0);
        assert_eq!(file.version, FILE_VERSION);
        assert!(file.todos.is_empty());
        // 读不该顺手创建文件
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ─── 2. 写入后读回、rev 自增 ───

    #[test]
    fn save_then_load_roundtrip_bumps_rev() {
        let dir = temp_dir("roundtrip");
        let path = todo_path_in(&dir);

        let todos = vec![item("a1", "买牛奶", false, Some(("2027-01-05", 1_799_164_799_999)), 1_793_704_798_810)];
        let rev1 = save_at(&path, todos.clone()).unwrap();
        assert_eq!(rev1, 1);
        let loaded = load_at(&path).unwrap();
        assert_eq!(loaded.rev, 1);
        assert_eq!(loaded.todos, todos);

        let rev2 = save_at(&path, todos.clone()).unwrap();
        assert_eq!(rev2, 2);
        assert_eq!(load_at(&path).unwrap().rev, 2);

        // 落盘形状必须是 camelCase，且 None 字段不出现
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\"deadlineTs\""), "应为 camelCase: {raw}");
        assert!(raw.contains("\"createdAt\""), "应为 camelCase: {raw}");
        assert!(!raw.contains("deadline_ts"), "不许出现 snake_case: {raw}");
        assert!(!raw.contains("created_at"), "不许出现 snake_case: {raw}");
        assert_eq!(loaded.version, FILE_VERSION, "版本号必须落盘");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn options_are_skipped_when_none() {
        let dir = temp_dir("skipnone");
        let path = todo_path_in(&dir);
        save_at(&path, vec![item("a1", "无截止时间", false, None, 1)]).unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(!raw.contains("deadline"), "None 不应落盘: {raw}");
        assert!(raw.contains("\"todos\""));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_creates_missing_directory() {
        let dir = temp_dir("mkdir");
        let nested = dir.join("a").join("b");
        let path = todo_path_in(&nested);
        save_at(&path, vec![item("a1", "x", false, None, 1)]).unwrap();
        assert!(path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ─── 3. 损坏文件 → Err，且内容原封不动 ───

    #[test]
    fn corrupt_file_errors_and_is_never_overwritten() {
        let dir = temp_dir("corrupt");
        let path = todo_path_in(&dir);
        let broken = "{ \"version\": 1, \"rev\": 5, \"todos\": [ {oops";
        std::fs::write(&path, broken).unwrap();

        let err = load_at(&path).unwrap_err();
        assert!(err.is_corrupt(), "应报损坏: {err:?}");
        assert!(err.to_string().contains("损坏"));

        // 写也必须拒绝，且断言文件内容没被改
        let err = save_at(&path, vec![item("a1", "x", false, None, 1)]).unwrap_err();
        assert!(err.is_corrupt(), "损坏文件不许被覆盖: {err:?}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), broken);
        assert!(!tmp_path(&path).exists(), "失败后不该留 tmp");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn structurally_wrong_file_is_corrupt() {
        let dir = temp_dir("wrongshape");
        let path = todo_path_in(&dir);
        // 合法 JSON 但不是我们约定的形状
        let broken = r#"{"todo":[]}"#;
        std::fs::write(&path, broken).unwrap();
        let err = load_at(&path).unwrap_err();
        assert!(err.is_corrupt());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), broken);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn blank_file_reads_as_empty_not_corrupt() {
        // 空白 / 0 字节 = "创建了还没写"或"写到一半掉电"，按空列表处理；
        // 锁成只读的话用户既看不到数据、也没法再写任何东西
        let dir = temp_dir("emptyfile");
        let path = todo_path_in(&dir);

        std::fs::write(&path, "   \n\t\r\n").unwrap();
        let file = load_at(&path).expect("空白文件应视为空列表");
        assert_eq!(file.rev, 0);
        assert_eq!(file.version, FILE_VERSION);
        assert!(file.todos.is_empty());

        std::fs::write(&path, "").unwrap();
        assert!(load_at(&path).unwrap().todos.is_empty(), "0 字节同理");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ─── 3b. 读入宽容度（真机回归） ───

    /// 真机回归：`%APPDATA%\com.infoboard.tauri\todo.json` 里就是这么一份 17 字节的文件
    /// （2026-07-08 生成，缺 `version` / `rev`）。以前是 `missing field version` → Corrupt
    /// → app 一打开就"数据损坏只读"，而里面其实一条待办都没有。
    #[test]
    fn minimal_file_without_version_or_rev_loads() {
        let dir = temp_dir("minimal");
        let path = todo_path_in(&dir);
        let raw = "{\n  \"todos\": []\n}";
        assert_eq!(raw.len(), 17, "就是要复现那份 17 字节的文件");
        std::fs::write(&path, raw).unwrap();

        let file = load_at(&path).expect("{\"todos\": []} 必须能读，不能判损坏");
        assert_eq!(file.rev, 0, "缺 rev 等价于 rev 0（= 谁也没写过）");
        assert!(file.todos.is_empty());
        assert_eq!(file.version, FILE_VERSION, "缺 version 按当前版本算");
        // 读完不该顺手改写文件
        assert_eq!(std::fs::read_to_string(&path).unwrap(), raw);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn item_without_completed_or_created_at_gets_defaults() {
        let dir = temp_dir("itemdefaults");
        let path = todo_path_in(&dir);
        std::fs::write(&path, r#"{"version":1,"rev":3,"todos":[{"id":"a","text":"甲"}]}"#).unwrap();

        let file = load_at(&path).expect("缺 completed/createdAt 的旧条目要能读");
        assert_eq!(file.rev, 3);
        assert_eq!(file.todos.len(), 1);
        let todo = &file.todos[0];
        assert_eq!(todo.id, "a");
        assert_eq!(todo.text, "甲");
        assert!(!todo.completed, "缺 completed → false");
        assert_eq!(todo.created_at, 0, "缺 createdAt → 0");
        assert!(todo.deadline.is_none(), "缺 deadline → None");
        assert!(todo.deadline_ts.is_none(), "缺 deadlineTs → None");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 裸数组 = 老 `localStorage['todo-list']` 的形状；与"文件不存在"语义等价（rev 0）
    #[test]
    fn bare_array_file_loads_as_rev_zero() {
        let dir = temp_dir("barearray");
        let path = todo_path_in(&dir);
        std::fs::write(&path, r#"[{"id":"a","text":"甲","completed":false,"createdAt":1}]"#).unwrap();

        let file = load_at(&path).expect("裸数组不该被判损坏");
        assert_eq!(file.rev, 0);
        assert_eq!(file.version, FILE_VERSION);
        assert_eq!(file.todos, vec![item("a", "甲", false, None, 1)]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 宽容 ≠ 什么都收：这几条补不出来，必须还是 Corrupt（否则等于毁数据）
    #[test]
    fn truly_broken_files_are_still_corrupt() {
        let dir = temp_dir("trulybroken");
        let path = todo_path_in(&dir);
        let cases = [
            r#"{"todos": "x"}"#,   // todos 类型不对
            r#"{"todos": []"#,     // 截断
            "{}",                  // 连 todos 都没有 → 猜成空表就是扔数据
            "[1,2]",               // 不是对象数组：两条解析路都不该成功
            r#"[{"text":"缺 id"}]"#, // 缺 id 必填字段
            r#"[{"id":"a"}]"#,     // 缺 text
        ];
        for raw in cases {
            std::fs::write(&path, raw).unwrap();
            let err = load_at(&path).unwrap_err();
            assert!(err.is_corrupt(), "{raw} 应报损坏，实际：{err:?}");
            // 文案里要带原始 serde 报错，方便用户/脚本定位
            assert!(err.to_string().contains("解析失败"), "{raw} 的文案：{err}");
            assert_eq!(std::fs::read_to_string(&path).unwrap(), raw, "读失败不许改文件");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 0 字节 → 空列表；但二进制垃圾（含 NUL / 非 UTF-8）仍然是损坏，不能一起放宽
    #[test]
    fn zero_byte_is_empty_but_binary_is_corrupt() {
        let dir = temp_dir("zerobyte");
        let path = todo_path_in(&dir);

        std::fs::write(&path, b"").unwrap();
        let file = load_at(&path).expect("0 字节 = 还没写，不是损坏");
        assert_eq!(file.rev, 0);
        assert!(file.todos.is_empty());

        // 含 NUL 的字节是合法 UTF-8，但 JSON 解析必败
        std::fs::write(&path, b"{ \"todos\": [] }\x00\x00").unwrap();
        assert!(load_at(&path).unwrap_err().is_corrupt(), "含 NUL 的垃圾仍算损坏");

        // 非 UTF-8（真二进制）在更前面一层就被拦下
        std::fs::write(&path, [0xff, 0xfe, 0x00, 0x00, 0x7b]).unwrap();
        let err = load_at(&path).unwrap_err();
        assert!(err.is_corrupt(), "非 UTF-8 仍算损坏：{err:?}");
        assert!(err.to_string().contains("UTF-8"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ─── 4. 日期解析 ───

    #[test]
    fn iso_dates_are_strictly_validated() {
        let now = at(2026, 3, 8);

        let ts = parse_deadline_to_day_end("2026-03-08", now).expect("2026-03-08 合法");
        let expected = Local
            .with_ymd_and_hms(2026, 3, 8, 23, 59, 59)
            .single()
            .unwrap()
            .timestamp_millis()
            + 999;
        assert_eq!(ts, expected);

        assert_eq!(parse_deadline_to_day_end("2026-02-30", now), None, "2 月没有 30 号");
        assert!(parse_deadline_to_day_end("2028-02-29", now).is_some(), "2028 是闰年");
        assert_eq!(parse_deadline_to_day_end("2026-02-29", now), None, "2026 不是闰年");

        // 格式必须严格
        assert_eq!(parse_deadline_to_day_end("2026-3-8", now), None);
        assert_eq!(parse_deadline_to_day_end("2026/03/08", now), None);
        assert!(parse_deadline_to_day_end(" 2026-03-08 ", now).is_some(), "两端空白要容忍");
    }

    #[test]
    fn chinese_dates_resolve_next_occurrence() {
        let now = at(2026, 1, 1);
        assert_eq!(chinese_date_to_iso("3月8日", now).as_deref(), Some("2026-03-08"));
        assert!(parse_deadline_to_day_end("3月8日", now).is_some());
        // 今年这一天已经过去 → 明年
        assert_eq!(chinese_date_to_iso("12月31日", at(2026, 6, 1)).as_deref(), Some("2026-12-31"));
        // 不存在的日期
        assert_eq!(parse_deadline_to_day_end("2月30日", now), None);
        assert_eq!(chinese_date_to_iso("2月30日", now), None);
        assert_eq!(parse_deadline_to_day_end("2月29日", at(2026, 1, 1)), None);
        // 自由文本一律解析不了（不能被"猜"成某一天）
        assert_eq!(parse_deadline_to_day_end("明天", now), None);
        assert_eq!(parse_deadline_to_day_end("下周三", now), None);
        assert_eq!(parse_deadline_to_day_end("", now), None);
    }

    // ─── 5. 跨年 ───

    #[test]
    fn chinese_date_crosses_year_boundary() {
        let now = at(2026, 12, 31);
        assert_eq!(chinese_date_to_iso("1月5日", now).as_deref(), Some("2027-01-05"));
        let ts = parse_deadline_to_day_end("1月5日", now).unwrap();
        let expected = Local
            .with_ymd_and_hms(2027, 1, 5, 23, 59, 59)
            .single()
            .unwrap()
            .timestamp_millis()
            + 999;
        assert_eq!(ts, expected);

        // 同一天算今年（"下一次出现"包含今天）
        assert_eq!(chinese_date_to_iso("12月31日", now).as_deref(), Some("2026-12-31"));
    }

    #[test]
    fn normalize_deadline_converts_chinese_to_iso() {
        let now = at(2026, 12, 31);
        let (deadline, ts) = normalize_deadline(" 1月5日 ", now).unwrap();
        assert_eq!(deadline, "2027-01-05");
        assert!(ts > 0);
        let (deadline, _) = normalize_deadline("2027-01-05", now).unwrap();
        assert_eq!(deadline, "2027-01-05");
        assert_eq!(normalize_deadline("明天", now), None);
    }

    #[test]
    fn overdue_only_after_the_day_ends() {
        let now = at(2026, 3, 8); // 2026-03-08 10:30 本地
        let today = item("a", "今天到期", false, parse_deadline_to_day_end("2026-03-08", now).map(|ts| ("2026-03-08", ts)), 1);
        assert!(!is_overdue(&today, now.timestamp_millis()), "当天不算逾期");

        let yesterday = item("b", "昨天到期", false, parse_deadline_to_day_end("2026-03-07", now).map(|ts| ("2026-03-07", ts)), 1);
        assert!(is_overdue(&yesterday, now.timestamp_millis()));

        let mut done = yesterday.clone();
        done.completed = true;
        assert!(!is_overdue(&done, now.timestamp_millis()), "已完成不算逾期");
    }

    // ─── 6. 排序 ───

    #[test]
    fn sorting_matches_frontend_rules() {
        let todos = vec![
            // 已完成，有 deadline 但必须沉底
            item("done1", "已完成早到期", true, Some(("2020-01-01", 100)), 5_000),
            item("late", "未完成晚到期", false, Some(("2026-12-01", 900)), 1_000),
            item("early", "未完成早到期", false, Some(("2026-03-01", 300)), 1_000),
            item("nodl-old", "无截止(旧)", false, None, 1_000),
            item("nodl-new", "无截止(新)", false, None, 9_000),
        ];
        let ordered = sorted(&todos);
        let ids: Vec<&str> = ordered.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["early", "late", "nodl-new", "nodl-old", "done1"],
            "未完成在前 → 有 deadline 升序 → 无 deadline 按 createdAt 降序 → 已完成沉底"
        );

        // 两个都已完成时同样按 deadline 升序
        let done = vec![
            item("d2", "b", true, Some(("2026-05-01", 700)), 1),
            item("d1", "a", true, Some(("2026-04-01", 600)), 1),
        ];
        let ordered = sorted(&done);
        let ids: Vec<&str> = ordered.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, vec!["d1", "d2"]);
    }

    // ─── 旧数据迁移 ───

    /// 文件不存在 → 照旧导入到 rev 1；第二次调用（已有数据）→ `Ok(None)` 且不覆盖
    #[test]
    fn legacy_import_runs_when_file_absent() {
        let dir = temp_dir("legacy");
        let path = todo_path_in(&dir);
        let raw = r#"[{"id":"x1","text":"老待办","completed":false,"createdAt":1000}]"#;

        let rev = import_legacy_at(&path, raw).unwrap();
        assert_eq!(rev, Some(1), "不存在 → 导入，rev 从 1 开始");
        let loaded = load_at(&path).unwrap();
        assert_eq!(loaded.rev, 1);
        assert_eq!(loaded.version, FILE_VERSION);
        assert_eq!(loaded.todos.len(), 1);
        assert_eq!(loaded.todos[0].text, "老待办");

        // 第二次调用：文件里已有数据 → Ok(None)，且不覆盖
        let again = import_legacy_at(&path, r#"[{"id":"y2","text":"不该进来","completed":true,"createdAt":2}]"#).unwrap();
        assert_eq!(again, None);
        assert_eq!(load_at(&path).unwrap().todos[0].text, "老待办");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 最关键的一条：真机上那份 `{"todos": []}` 空壳必须能让迁移进来，
    /// 否则 localStorage 里的真实待办永远搬不过来（app 还同时是"损坏只读"态）
    #[test]
    fn legacy_import_overwrites_existing_empty_shell() {
        let dir = temp_dir("legacyshell");
        let path = todo_path_in(&dir);
        std::fs::write(&path, "{\n  \"todos\": []\n}\n").unwrap();

        let raw = r#"[{"id":"x1","text":"从 localStorage 迁过来","completed":false,"createdAt":1000}]"#;
        let rev = import_legacy_at(&path, raw).unwrap();
        assert_eq!(rev, Some(1), "空壳文件（rev 0、无待办）允许导入");

        let loaded = load_at(&path).unwrap();
        assert_eq!(loaded.rev, 1);
        assert_eq!(loaded.version, FILE_VERSION, "导入后必须是正式形状");
        assert_eq!(loaded.todos.len(), 1);
        assert_eq!(loaded.todos[0].text, "从 localStorage 迁过来");
        let on_disk = std::fs::read_to_string(&path).unwrap();
        assert!(on_disk.contains("\"version\""), "落盘要带 version: {on_disk}");
        assert!(on_disk.contains("\"rev\": 1"), "落盘 rev 应为 1: {on_disk}");

        // 再调一次：现在 rev > 0 且非空 → 不许再覆盖
        assert_eq!(import_legacy_at(&path, raw).unwrap(), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 有数据（rev > 0 或 todos 非空）→ 绝不覆盖，且文件字节一个都不能变
    #[test]
    fn legacy_import_refuses_existing_data_untouched() {
        let dir = temp_dir("legacykeep");
        let path = todo_path_in(&dir);

        // a) rev > 0 但列表为空
        let raw = "{\n  \"version\": 1,\n  \"rev\": 5,\n  \"todos\": []\n}\n";
        std::fs::write(&path, raw).unwrap();
        let payload = r#"[{"id":"x1","text":"不该进来","completed":false,"createdAt":1}]"#;
        assert_eq!(import_legacy_at(&path, payload).unwrap(), None, "rev 5 → 不导入");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), raw, "文件必须一字不改");

        // b) rev 0 但有数据（手写文件没写 rev）
        let raw = r#"{"todos":[{"id":"a","text":"已有","completed":false,"createdAt":1}]}"#;
        std::fs::write(&path, raw).unwrap();
        assert_eq!(import_legacy_at(&path, payload).unwrap(), None, "非空 → 不导入");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), raw, "文件必须一字不改");

        // c) 裸数组（rev 视作 0）但有数据 → 同样不导入
        let raw = r#"[{"id":"a","text":"已有","completed":false,"createdAt":1}]"#;
        std::fs::write(&path, raw).unwrap();
        assert_eq!(import_legacy_at(&path, payload).unwrap(), None, "裸数组非空 → 不导入");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), raw, "文件必须一字不改");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 文件损坏 → 把 Corrupt 原样透出去（前端据此备份原文），且不写任何东西
    #[test]
    fn legacy_import_refuses_corrupt_file_untouched() {
        let dir = temp_dir("legacycorrupt");
        let path = todo_path_in(&dir);
        let raw = "{\n  \"version\": 1,\n  \"rev\": 2,\n  \"todos\": [ {oops";
        std::fs::write(&path, raw).unwrap();

        let err = import_legacy_at(&path, r#"[{"id":"x1","text":"不该进来","completed":false,"createdAt":1}]"#).unwrap_err();
        assert!(err.is_corrupt(), "损坏要原样报出：{err:?}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), raw, "损坏文件必须一字不改");
        assert!(!tmp_path(&path).exists(), "不该留 tmp");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `raw == "[]"` = 用户确实给了个（空）数组：照写，rev 1，不特判成 None
    #[test]
    fn legacy_import_of_empty_array_creates_file() {
        let dir = temp_dir("legacyemptyarr");
        let path = todo_path_in(&dir);
        assert_eq!(import_legacy_at(&path, "[]").unwrap(), Some(1));
        assert!(path.exists(), "空数组迁移也要落盘（表示\"迁移过了\"）");
        let loaded = load_at(&path).unwrap();
        assert_eq!(loaded.rev, 1);
        assert!(loaded.todos.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn legacy_import_rejects_broken_json_without_writing() {
        let dir = temp_dir("legacybad");
        let path = todo_path_in(&dir);
        let err = import_legacy_at(&path, "[{oops").unwrap_err();
        assert!(err.is_corrupt());
        assert!(!path.exists(), "解析失败时不许写任何东西");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn legacy_import_of_empty_payload_is_a_noop() {
        let dir = temp_dir("legacyempty");
        let path = todo_path_in(&dir);
        assert_eq!(import_legacy_at(&path, "  ").unwrap(), None);
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ─── 路径 ───

    #[test]
    fn data_dir_env_override_wins() {
        let dir = temp_dir("envdir");
        let previous = std::env::var_os(DATA_DIR_ENV);
        // 注意：edition 2021 下 set_var 是安全函数；这里只在本测试内设置并立刻还原
        std::env::set_var(DATA_DIR_ENV, &dir);
        let resolved = data_dir().unwrap();
        let path = todo_path().unwrap();
        match previous {
            Some(value) => std::env::set_var(DATA_DIR_ENV, value),
            None => std::env::remove_var(DATA_DIR_ENV),
        }
        assert_eq!(resolved, dir);
        assert_eq!(path, todo_path_in(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ids_are_unique_and_url_safe() {
        let a = new_id();
        let b = new_id();
        assert_ne!(a, b);
        assert!(a.chars().all(|c| c.is_ascii_alphanumeric()), "id 只能是 0-9a-z: {a}");
        assert!(a.len() >= 4);
    }

    // ─── 声明式同步（apply） ───

    fn apply_item(id: &str, text: &str, deadline: Option<&str>, completed: bool) -> ApplyItem {
        ApplyItem {
            id: id.to_string(),
            text: text.to_string(),
            deadline: deadline.map(|d| d.to_string()),
            completed,
        }
    }

    /// 与前端等价的"当天 23:59:59.999"毫秒时间戳
    fn day_end_ms(year: i32, month: u32, day: u32) -> i64 {
        Local
            .with_ymd_and_hms(year, month, day, 23, 59, 59)
            .single()
            .unwrap()
            .timestamp_millis()
            + 999
    }

    /// 1. 空文件 + 3 条 → 全部新增，落盘是正式形状（version / rev / createdAt）
    #[test]
    fn apply_adds_all_items_into_missing_file() {
        let dir = temp_dir("applyadd");
        let path = todo_path_in(&dir);
        let items = vec![
            apply_item("cx-0001", "第一条", None, false),
            apply_item("cx-0002", "第二条", Some("2026-11-10"), false),
            apply_item("cx-0003", "第三条", None, true),
        ];

        let report = apply_at(&path, &items, &[], false).unwrap();
        assert_eq!(
            report,
            ApplyReport { rev: 1, added: 3, updated: 0, removed: 0, unchanged: 0, dry_run: false }
        );

        let loaded = load_at(&path).unwrap();
        assert_eq!(loaded.version, FILE_VERSION, "落盘必须带 version");
        assert_eq!(loaded.rev, 1);
        assert_eq!(loaded.todos.len(), 3);
        assert!(loaded.todos.iter().all(|todo| todo.created_at > 0), "新增条目要带 createdAt");
        assert_eq!(loaded.todos[1].deadline.as_deref(), Some("2026-11-10"));
        assert_eq!(loaded.todos[1].deadline_ts, Some(day_end_ms(2026, 11, 10)));
        assert!(loaded.todos[2].completed);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 2. 幂等：同样的清单再 apply 一次 → 全"未变"，rev 与文件字节 / mtime 都不许变
    #[test]
    fn apply_is_idempotent_and_does_not_touch_the_file() {
        let dir = temp_dir("applyidem");
        let path = todo_path_in(&dir);
        let items = vec![
            apply_item("cx-0001", "第一条", None, false),
            apply_item("cx-0002", "第二条", Some("2026-11-10"), false),
            apply_item("cx-0003", "第三条", None, true),
        ];
        apply_at(&path, &items, &[], false).unwrap();

        let bytes_before = std::fs::read(&path).unwrap();
        let mtime_before = std::fs::metadata(&path).unwrap().modified().unwrap();

        let report = apply_at(&path, &items, &[], false).unwrap();
        assert_eq!(report.rev, 1, "无变化不许涨 rev");
        assert_eq!(report.unchanged, 3);
        assert_eq!((report.added, report.updated, report.removed), (0, 0, 0));
        assert_eq!(std::fs::read(&path).unwrap(), bytes_before, "无变化不许重写文件");
        assert_eq!(
            std::fs::metadata(&path).unwrap().modified().unwrap(),
            mtime_before,
            "mtime 也不许动（说明真的没写）"
        );
        assert!(!tmp_path(&path).exists(), "不该留 tmp");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 3. 改 text → 更新 1 条，`createdAt` 保持原值（"第一次见到它"的时间不该被同步刷掉）
    #[test]
    fn apply_updates_text_and_keeps_created_at() {
        let dir = temp_dir("applytext");
        let path = todo_path_in(&dir);
        apply_at(&path, &[apply_item("cx-0001", "旧文案", Some("2026-11-10"), false)], &[], false).unwrap();
        let created_before = load_at(&path).unwrap().todos[0].created_at;

        let report = apply_at(&path, &[apply_item("cx-0001", "新文案", Some("2026-11-10"), false)], &[], false).unwrap();
        assert_eq!(report.updated, 1);
        assert_eq!(report.added, 0);
        assert_eq!(report.rev, 2);

        let todo = load_at(&path).unwrap().todos[0].clone();
        assert_eq!(todo.text, "新文案");
        assert_eq!(todo.created_at, created_before, "createdAt 必须保留");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 4. 改 deadline → 更新 1 条，`deadlineTs` 按"当天 23:59:59.999"重算
    #[test]
    fn apply_updates_deadline_and_recomputes_ts() {
        let dir = temp_dir("applydeadline");
        let path = todo_path_in(&dir);
        apply_at(&path, &[apply_item("cx-0001", "写报告", Some("2026-11-09"), false)], &[], false).unwrap();
        assert_eq!(load_at(&path).unwrap().todos[0].deadline_ts, Some(day_end_ms(2026, 11, 9)));

        let report = apply_at(&path, &[apply_item("cx-0001", "写报告", Some("2026-11-10"), false)], &[], false).unwrap();
        assert_eq!(report.updated, 1);
        let todo = load_at(&path).unwrap().todos[0].clone();
        assert_eq!(todo.deadline.as_deref(), Some("2026-11-10"));
        assert_eq!(todo.deadline_ts, Some(day_end_ms(2026, 11, 10)));

        // 中文日期同样要归一化成 ISO（年份随注入的 now 走）
        let report = apply_with_now(
            &path,
            &[apply_item("cx-0002", "交房租", Some("3月8日"), false)],
            &[],
            false,
            at(2026, 1, 1),
            1_000,
        )
        .unwrap();
        assert_eq!(report.added, 1);
        let added = load_at(&path).unwrap().todos.iter().find(|t| t.id == "cx-0002").unwrap().clone();
        assert_eq!(added.deadline.as_deref(), Some("2026-03-08"), "M月D日 要归一化成 ISO");
        assert_eq!(added.deadline_ts, Some(day_end_ms(2026, 3, 8)));
        assert_eq!(added.created_at, 1_000, "createdAt 取注入的 now_ms");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 5. `completed` 不许降级：已有 true + 来源说 false → 未变，仍然 true，且不写盘
    #[test]
    fn apply_never_downgrades_completed() {
        let dir = temp_dir("applynodowngrade");
        let path = todo_path_in(&dir);
        save_at(&path, vec![item("cx-0001", "已经做完了", true, Some(("2026-11-10", day_end_ms(2026, 11, 10))), 12_345)]).unwrap();
        let bytes_before = std::fs::read(&path).unwrap();

        let report = apply_at(&path, &[apply_item("cx-0001", "已经做完了", Some("2026-11-10"), false)], &[], false).unwrap();
        assert_eq!(report.unchanged, 1);
        assert_eq!(report.rev, 1, "只有 completed 想往回改 → 无变化，不写盘");
        assert_eq!(std::fs::read(&path).unwrap(), bytes_before);
        assert!(load_at(&path).unwrap().todos[0].completed, "true 不许被改成 false");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 5b. 反方向（false → true）要真的落盘：这是"来源说做完了"唯一能生效的通道。
    /// 按契约它**不计入 updated**（text / deadline 没变），所以报告是 unchanged=1 + rev +1。
    #[test]
    fn apply_upgrades_completed_and_persists_it() {
        let dir = temp_dir("applyupgrade");
        let path = todo_path_in(&dir);
        apply_at(&path, &[apply_item("cx-0001", "该做完了", None, false)], &[], false).unwrap();

        let report = apply_at(&path, &[apply_item("cx-0001", "该做完了", None, true)], &[], false).unwrap();
        assert_eq!((report.added, report.updated, report.removed), (0, 0, 0));
        assert_eq!(report.unchanged, 1, "completed 合并本身不算 updated");
        assert_eq!(report.rev, 2, "但数据真的变了 → 必须写盘，rev +1");
        assert!(load_at(&path).unwrap().todos[0].completed, "false → true 必须生效");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 6. prune 只删"前缀命中且本次清单没给"的条目，别人的条目一条都不许碰
    #[test]
    fn apply_prune_removes_only_matching_prefix() {
        let dir = temp_dir("applyprune");
        let path = todo_path_in(&dir);
        save_at(
            &path,
            vec![
                item("cx-a", "来源 A", false, None, 1),
                item("cx-b", "来源 B", false, None, 2),
                item("mine-1", "自己加的", false, None, 3),
            ],
        )
        .unwrap();

        let report = apply_at(&path, &[apply_item("cx-a", "来源 A", None, false)], &["cx-".to_string()], false).unwrap();
        assert_eq!(report.removed, 1, "只删 cx-b");
        assert_eq!(report.unchanged, 1);
        assert_eq!(report.rev, 2);

        let ids: Vec<String> = load_at(&path).unwrap().todos.into_iter().map(|t| t.id).collect();
        assert_eq!(ids, vec!["cx-a", "mine-1"], "顺序按文件原顺序，且 mine-1 必须还在");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 7. 多前缀各删一条
    #[test]
    fn apply_prune_handles_multiple_prefixes() {
        let dir = temp_dir("applyprunemulti");
        let path = todo_path_in(&dir);
        save_at(
            &path,
            vec![
                item("cx-1", "来源甲", false, None, 1),
                item("hw-1", "来源乙", false, None, 2),
                item("keep-1", "保留", false, None, 3),
            ],
        )
        .unwrap();

        let prefixes = vec!["cx-".to_string(), "hw-".to_string()];
        let report = apply_at(&path, &[], &prefixes, false).unwrap();
        assert_eq!(report.removed, 2);
        assert_eq!(report.rev, 2);
        assert_eq!(load_at(&path).unwrap().todos, vec![item("keep-1", "保留", false, None, 3)]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// prune 为空 → **一条都不删**（默认绝不删）
    #[test]
    fn apply_without_prune_never_deletes_anything() {
        let dir = temp_dir("applynoprune");
        let path = todo_path_in(&dir);
        save_at(&path, vec![item("cx-1", "来源甲", false, None, 1), item("mine", "自己的", false, None, 2)]).unwrap();
        let bytes_before = std::fs::read(&path).unwrap();

        let report = apply_at(&path, &[], &[], false).unwrap();
        assert_eq!((report.added, report.updated, report.removed, report.unchanged), (0, 0, 0, 0));
        assert_eq!(report.rev, 1);
        assert_eq!(std::fs::read(&path).unwrap(), bytes_before, "prune 为空时什么都不该做");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 8. items 里重复 id → Err(Corrupt)，文件字节不变
    #[test]
    fn apply_rejects_duplicate_ids_without_writing() {
        let dir = temp_dir("applydup");
        let path = todo_path_in(&dir);
        save_at(&path, vec![item("cx-1", "已有", false, None, 1)]).unwrap();
        let bytes_before = std::fs::read(&path).unwrap();

        let items = vec![apply_item("cx-2", "甲", None, false), apply_item("cx-2", "乙", None, false)];
        let err = apply_at(&path, &items, &[], false).unwrap_err();
        assert!(err.is_corrupt(), "{err:?}");
        assert!(err.to_string().contains("重复 id"), "{err}");
        assert_eq!(std::fs::read(&path).unwrap(), bytes_before, "整批不写");
        assert!(!tmp_path(&path).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 9. 非法 deadline（2 月 30 号）→ Err(Corrupt)，整批不写
    #[test]
    fn apply_rejects_invalid_deadline_without_writing() {
        let dir = temp_dir("applybaddate");
        let path = todo_path_in(&dir);
        let bytes_before = std::fs::read(&path).ok();
        assert!(bytes_before.is_none(), "文件还不存在");

        let items = vec![
            apply_item("cx-1", "合法的一条", Some("2026-11-10"), false),
            apply_item("cx-2", "非法日期", Some("2026-02-30"), false),
        ];
        let err = apply_at(&path, &items, &[], false).unwrap_err();
        assert!(err.is_corrupt(), "{err:?}");
        assert!(err.to_string().contains("无法识别的截止日期"), "{err}");
        assert!(!path.exists(), "整批不写：连合法的那条也不许落盘");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 10. 空清单 + prune → 前缀命中的全删，其它保留，rev +1
    #[test]
    fn apply_empty_items_with_prune_removes_all_matching() {
        let dir = temp_dir("applyemptyprune");
        let path = todo_path_in(&dir);
        save_at(
            &path,
            vec![
                item("cx-1", "来源甲", false, None, 1),
                item("cx-2", "来源乙", true, None, 2),
                item("mine", "自己的", false, None, 3),
            ],
        )
        .unwrap();

        let report = apply_at(&path, &[], &["cx-".to_string()], false).unwrap();
        assert_eq!(report.removed, 2);
        assert_eq!(report.added, 0);
        assert_eq!(report.rev, 2);
        assert_eq!(load_at(&path).unwrap().todos, vec![item("mine", "自己的", false, None, 3)]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 11. dry-run：计数照算，文件一个字节都不动、rev 也不变
    #[test]
    fn apply_dry_run_reports_without_writing() {
        let dir = temp_dir("applydry");
        let path = todo_path_in(&dir);
        save_at(
            &path,
            vec![
                item("cx-1", "来源甲", false, None, 1),
                item("cx-2", "来源乙", false, None, 2),
                item("mine", "自己的", false, None, 3),
            ],
        )
        .unwrap();
        let bytes_before = std::fs::read(&path).unwrap();

        let items = vec![
            apply_item("cx-1", "来源甲（改过）", None, false),
            apply_item("cx-9", "新的", None, false),
        ];
        let report = apply_at(&path, &items, &["cx-".to_string()], true).unwrap();
        assert_eq!(
            report,
            ApplyReport { rev: 1, added: 1, updated: 1, removed: 1, unchanged: 0, dry_run: true }
        );
        assert_eq!(std::fs::read(&path).unwrap(), bytes_before, "dry-run 不许写盘");
        assert_eq!(load_at(&path).unwrap().rev, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 12. 数据文件损坏 → Err(Corrupt)，文件原封不动
    #[test]
    fn apply_refuses_corrupt_file_untouched() {
        let dir = temp_dir("applycorrupt");
        let path = todo_path_in(&dir);
        let broken = "{\n  \"version\": 1,\n  \"rev\": 4,\n  \"todos\": [ {oops";
        std::fs::write(&path, broken).unwrap();

        let err = apply_at(&path, &[apply_item("cx-1", "甲", None, false)], &["cx-".to_string()], false).unwrap_err();
        assert!(err.is_corrupt(), "{err:?}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), broken, "损坏文件必须一字不改");
        assert!(!tmp_path(&path).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 13. text 为空 → Err，文件字节不变（不许静默跳过、也不许把空文本写进去）
    #[test]
    fn apply_rejects_blank_text_without_writing() {
        let dir = temp_dir("applyblank");
        let path = todo_path_in(&dir);
        save_at(&path, vec![item("cx-1", "已有", false, None, 1)]).unwrap();
        let bytes_before = std::fs::read(&path).unwrap();

        let err = apply_at(&path, &[apply_item("cx-2", "   ", None, false)], &[], false).unwrap_err();
        assert!(err.is_corrupt(), "数据层只拦不让写的情况：{err:?}");
        assert_eq!(std::fs::read(&path).unwrap(), bytes_before);

        let err = apply_at(&path, &[apply_item("  ", "有文本没 id", None, false)], &[], false).unwrap_err();
        assert!(err.is_corrupt(), "id 空白同样是输入问题：{err:?}");
        assert_eq!(std::fs::read(&path).unwrap(), bytes_before);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 顺序：已有条目保持文件里的原顺序，新增条目按清单顺序追加在后（顺序只为可复现）
    #[test]
    fn apply_keeps_existing_order_and_appends_new_items() {
        let dir = temp_dir("applyorder");
        let path = todo_path_in(&dir);
        save_at(&path, vec![item("cx-b", "乙", false, None, 2), item("cx-a", "甲", false, None, 1)]).unwrap();

        let items = vec![
            apply_item("cx-c", "丙", None, false),
            apply_item("cx-a", "甲（改）", None, false),
        ];
        let report = apply_at(&path, &items, &[], false).unwrap();
        assert_eq!((report.added, report.updated), (1, 1));

        let ids: Vec<String> = load_at(&path).unwrap().todos.into_iter().map(|t| t.id).collect();
        assert_eq!(ids, vec!["cx-b", "cx-a", "cx-c"], "已有按原顺序，新增追加在后");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
