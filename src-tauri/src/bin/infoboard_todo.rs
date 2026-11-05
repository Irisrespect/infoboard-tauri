//! `infoboard-todo` —— 待办命令行
//!
//! 直接复用 `core::todo_file`（与 app 同一份数据、同一套排序、同一套日期解析），
//! 所以 CLI 改的东西 app 刷新就能看到，反之亦然。
//!
//! **这是控制台程序**：`src/main.rs` 顶部的 `windows_subsystem = "windows"` 只作用于
//! 它自己，这里**不能**加同名属性，否则会把控制台窗口吞掉、输出全丢。
//!
//! 中文显示：Windows 控制台若不是 UTF-8 代码页（旧 conhost 默认 GBK），中文会变乱码，
//! 先执行 `chcp 65001` 再跑命令；PowerShell 7 / Windows Terminal 默认就是 UTF-8，无需处理。
//!
//! 退出码：0 成功 / 1 用法或参数错误 / 2 找不到目标 / 3 数据文件损坏。

use infoboard_tauri_lib::todo_file::{self, TodoError, TodoItem};
use std::io::Read;
use std::path::Path;
use std::process::ExitCode;

const EXIT_OK: u8 = 0;
const EXIT_USAGE: u8 = 1;
const EXIT_NOT_FOUND: u8 = 2;
const EXIT_CORRUPT: u8 = 3;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(()) => ExitCode::from(EXIT_OK),
        Err(err) => {
            // 错误一律走 stderr，脚本里 `2>/dev/null` 只丢错误不丢结果
            eprintln!("{}", err.message);
            ExitCode::from(err.code)
        }
    }
}

// ─────────────────────────── 错误 ───────────────────────────

#[derive(Debug)]
struct CliError {
    code: u8,
    message: String,
}

impl CliError {
    fn usage(message: impl Into<String>) -> Self {
        Self { code: EXIT_USAGE, message: message.into() }
    }
    fn not_found(message: impl Into<String>) -> Self {
        Self { code: EXIT_NOT_FOUND, message: message.into() }
    }
    fn corrupt(message: impl Into<String>) -> Self {
        Self { code: EXIT_CORRUPT, message: message.into() }
    }
}

/// 数据层错误 → CLI 退出码：损坏 = 3，其余 = 1
fn from_todo_error(err: TodoError) -> CliError {
    if err.is_corrupt() {
        CliError::corrupt(format!(
            "{err}\n（数据文件未被修改。请人工检查或先备份，再修好 JSON 后重试）"
        ))
    } else {
        CliError::usage(err.to_string())
    }
}

// ─────────────────────────── 分发 ───────────────────────────

fn run(args: &[String]) -> Result<(), CliError> {
    let Some(command) = args.first() else {
        // 无参数 = list（等价于 `infoboard-todo list`）
        return cmd_list(&[]);
    };
    let rest = &args[1..];
    match command.as_str() {
        "list" | "ls" => cmd_list(rest),
        "add" => cmd_add(rest),
        "done" => cmd_set_completed(rest, true),
        "undone" => cmd_set_completed(rest, false),
        "edit" => cmd_edit(rest),
        "rm" | "remove" | "del" => cmd_rm(rest),
        "clear" => cmd_clear(rest),
        "apply" => cmd_apply(rest),
        "path" => cmd_path(rest),
        "help" | "--help" | "-h" => {
            print_help();
            Ok(())
        }
        other => Err(CliError::usage(format!(
            "未知命令：{other}\n（可用命令：list / add / done / undone / edit / rm / clear / apply / path / help）"
        ))),
    }
}

// ─────────────────────────── list ───────────────────────────

#[derive(Clone, Copy, PartialEq)]
enum Filter {
    All,
    Active,
    Done,
}

fn cmd_list(args: &[String]) -> Result<(), CliError> {
    let mut filter = Filter::All;
    let mut json = false;
    for arg in args {
        match arg.as_str() {
            "--all" => filter = Filter::All,
            "--active" => filter = Filter::Active,
            "--done" => filter = Filter::Done,
            "--json" => json = true,
            other => {
                return Err(CliError::usage(format!(
                    "list 不认识这个参数：{other}\n用法：infoboard-todo list [--all|--active|--done] [--json]"
                )))
            }
        }
    }

    let file = todo_file::load().map_err(from_todo_error)?;
    let sorted = todo_file::sorted(&file.todos);
    let now = todo_file::now_ms();
    // 序号永远基于**完整排序列表**（即默认 `list` 看到的顺序），
    // 这样 `list --active` 里显示的 3 号就是 `done 3` 的目标，不会因为筛选而错位
    let rows: Vec<(usize, TodoItem)> = sorted
        .into_iter()
        .enumerate()
        .filter(|(_, todo)| match filter {
            Filter::All => true,
            Filter::Active => !todo.completed,
            Filter::Done => todo.completed,
        })
        .map(|(index, todo)| (index + 1, todo))
        .collect();

    if json {
        let payload = ListJson { rev: file.rev, todos: rows.iter().map(|(_, t)| t.clone()).collect() };
        let text = serde_json::to_string_pretty(&payload)
            .map_err(|err| CliError::usage(format!("序列化输出失败：{err}")))?;
        println!("{text}");
        return Ok(());
    }

    if rows.is_empty() {
        let hint = match filter {
            Filter::All => "还没有待办。用 `infoboard-todo add <文本>` 新建一条。",
            Filter::Active => "没有未完成的待办。",
            Filter::Done => "还没有已完成的待办。",
        };
        println!("{hint}");
        return Ok(());
    }

    print_rows(&rows, now);
    Ok(())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ListJson {
    rev: u64,
    todos: Vec<TodoItem>,
}

/// 按列对齐打印（中文字符按 2 列宽算，否则中文条目会歪）
fn print_rows(rows: &[(usize, TodoItem)], now_ms: i64) {
    let number_width = rows.iter().map(|(index, _)| index.to_string().len()).max().unwrap_or(1);
    let text_width = rows
        .iter()
        .map(|(_, todo)| display_width(&todo.text))
        .max()
        .unwrap_or(0);

    for (index, todo) in rows {
        let mark = if todo.completed { "✓" } else { "○" };
        let tail = tail_text(todo, now_ms);
        let mut line = format!("{index:>number_width$}. {mark} {}", todo.text);
        if !tail.is_empty() {
            let padding = text_width.saturating_sub(display_width(&todo.text)) + 2;
            line.push_str(&" ".repeat(padding));
            line.push_str(&tail);
        }
        println!("{}", line.trim_end());
    }
}

/// 行尾状态列
///
/// 逾期没法上色，用 `! 日期` 前缀表达（比只显示日期更明确，也不影响机器解析文本）。
fn tail_text(todo: &TodoItem, now_ms: i64) -> String {
    if todo.completed {
        return "(已完成)".to_string();
    }
    match (&todo.deadline, todo.deadline_ts) {
        (Some(deadline), _) => {
            if todo_file::is_overdue(todo, now_ms) {
                format!("! {deadline}（已逾期）")
            } else {
                deadline.clone()
            }
        }
        (None, _) => String::new(),
    }
}

/// 终端显示宽度：CJK / 全角字符按 2 算（够用即可，只用于对齐）
fn display_width(text: &str) -> usize {
    text.chars()
        .map(|c| {
            let code = c as u32;
            let wide = matches!(code,
                0x1100..=0x115F      // 韩文字母
                | 0x2E80..=0x303E    // CJK 部首 / 标点
                | 0x3041..=0x33FF    // 假名 / CJK 兼容
                | 0x3400..=0x4DBF    // CJK 扩展 A
                | 0x4E00..=0x9FFF    // CJK 基本区
                | 0xA000..=0xA4CF
                | 0xAC00..=0xD7A3    // 韩文音节
                | 0xF900..=0xFAFF
                | 0xFE30..=0xFE6F
                | 0xFF00..=0xFF60    // 全角
                | 0xFFE0..=0xFFE6
                | 0x20000..=0x3FFFD  // CJK 扩展 B+
            );
            if wide {
                2
            } else {
                1
            }
        })
        .sum()
}

// ─────────────────────────── add ───────────────────────────

fn cmd_add(args: &[String]) -> Result<(), CliError> {
    let mut words: Vec<String> = Vec::new();
    let mut deadline_arg: Option<String> = None;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "-d" | "--deadline" => {
                let value = args.get(i + 1).ok_or_else(|| {
                    CliError::usage("-d/--deadline 后面要跟日期，例如 -d 2027-01-05 或 -d 1月5日")
                })?;
                deadline_arg = Some(value.clone());
                i += 2;
            }
            other => {
                words.push(other.to_string());
                i += 1;
            }
        }
    }

    let text = words.join(" ").trim().to_string();
    if text.is_empty() {
        return Err(CliError::usage(
            "缺少待办内容\n用法：infoboard-todo add <文本...> [-d|--deadline <日期>]",
        ));
    }

    // 日期先解析：非法就退出 1，**不写文件**
    let now = chrono::Local::now();
    let deadline = match deadline_arg.as_deref() {
        None => None,
        Some(raw) => Some(todo_file::normalize_deadline(raw, now).ok_or_else(|| {
            CliError::usage(format!(
                "无法识别的截止日期：{raw}\n支持 `YYYY-MM-DD`（如 2027-01-05）或 `M月D日`（如 1月5日，取下一次出现的日期）"
            ))
        })?),
    };

    let mut file = todo_file::load().map_err(from_todo_error)?;
    let todo = TodoItem {
        id: todo_file::new_id(),
        text,
        completed: false,
        deadline: deadline.as_ref().map(|(text, _)| text.clone()),
        deadline_ts: deadline.as_ref().map(|(_, ts)| *ts),
        created_at: todo_file::now_ms(),
    };
    // 与前端一致：新条目插到最前面（最终顺序由排序决定）
    let mut todos = Vec::with_capacity(file.todos.len() + 1);
    todos.push(todo.clone());
    todos.extend(file.todos.drain(..));
    let rev = todo_file::save(todos).map_err(from_todo_error)?;

    // 打印新条目及其序号：重新读一次按排序算，避免自己算一套排序
    let sorted = todo_file::sorted(&read_todos()?);
    let index = sorted.iter().position(|item| item.id == todo.id).unwrap_or(0) + 1;
    println!("已新增 #{index}（rev {rev}）：{}", describe(&todo));
    Ok(())
}

fn read_todos() -> Result<Vec<TodoItem>, CliError> {
    Ok(todo_file::load().map_err(from_todo_error)?.todos)
}

// ─────────────────────────── done / undone ───────────────────────────

fn cmd_set_completed(args: &[String], completed: bool) -> Result<(), CliError> {
    let target = single_target(args, if completed { "done" } else { "undone" })?;

    let mut todos = read_todos()?;
    let sorted = todo_file::sorted(&todos);
    let position = resolve_target(&sorted, &target)?;
    let target_id = sorted[position].id.clone();

    let Some(slot) = todos.iter_mut().find(|todo| todo.id == target_id) else {
        return Err(CliError::not_found(format!("找不到待办：{target}")));
    };
    if slot.completed == completed {
        println!(
            "无需改动 #{}：{}",
            position + 1,
            describe(slot)
        );
        return Ok(());
    }
    slot.completed = completed;
    let updated = slot.clone();

    let rev = todo_file::save(todos).map_err(from_todo_error)?;
    println!(
        "已标记为{} #{}（rev {rev}）：{}",
        if completed { "已完成" } else { "未完成" },
        position + 1,
        describe(&updated)
    );
    Ok(())
}

// ─────────────────────────── edit ───────────────────────────

fn cmd_edit(args: &[String]) -> Result<(), CliError> {
    let mut target: Option<String> = None;
    let mut new_text: Option<String> = None;
    let mut deadline_arg: Option<String> = None;
    let mut clear_deadline = false;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "-t" | "--text" => {
                let value = args.get(i + 1).ok_or_else(|| {
                    CliError::usage("-t/--text 后面要跟新文本（含空格请加引号）")
                })?;
                new_text = Some(value.clone());
                i += 2;
            }
            "-d" | "--deadline" => {
                let value = args.get(i + 1).ok_or_else(|| {
                    CliError::usage("-d/--deadline 后面要跟日期，例如 -d 2027-01-05 或 -d 1月5日")
                })?;
                deadline_arg = Some(value.clone());
                i += 2;
            }
            "--clear-deadline" => {
                clear_deadline = true;
                i += 1;
            }
            other if target.is_none() && !other.starts_with('-') => {
                target = Some(other.to_string());
                i += 1;
            }
            other => {
                return Err(CliError::usage(format!(
                    "edit 不认识这个参数：{other}\n用法：infoboard-todo edit <目标> [-t|--text <新文本>] [-d|--deadline <日期>|--clear-deadline]"
                )))
            }
        }
    }

    let target = target.ok_or_else(|| {
        CliError::usage("缺少目标\n用法：infoboard-todo edit <目标> [-t|--text <新文本>] [-d|--deadline <日期>|--clear-deadline]")
    })?;
    if deadline_arg.is_some() && clear_deadline {
        return Err(CliError::usage("-d/--deadline 和 --clear-deadline 不能同时用"));
    }
    if new_text.is_none() && deadline_arg.is_none() && !clear_deadline {
        return Err(CliError::usage(
            "没有任何要改的内容\n至少给一个：-t <新文本> / -d <日期> / --clear-deadline",
        ));
    }
    if let Some(text) = &new_text {
        if text.trim().is_empty() {
            return Err(CliError::usage("新文本不能是空白"));
        }
    }
    // 日期先解析，非法就退出 1，不写文件
    let now = chrono::Local::now();
    let deadline = match deadline_arg.as_deref() {
        None => None,
        Some(raw) => Some(todo_file::normalize_deadline(raw, now).ok_or_else(|| {
            CliError::usage(format!(
                "无法识别的截止日期：{raw}\n支持 `YYYY-MM-DD`（如 2027-01-05）或 `M月D日`（如 1月5日）"
            ))
        })?),
    };

    let mut todos = read_todos()?;
    let sorted = todo_file::sorted(&todos);
    let position = resolve_target(&sorted, &target)?;
    let target_id = sorted[position].id.clone();

    let Some(slot) = todos.iter_mut().find(|todo| todo.id == target_id) else {
        return Err(CliError::not_found(format!("找不到待办：{target}")));
    };
    if let Some(text) = new_text {
        slot.text = text.trim().to_string();
    }
    if clear_deadline {
        slot.deadline = None;
        slot.deadline_ts = None;
    } else if let Some((deadline_text, ts)) = deadline {
        slot.deadline = Some(deadline_text);
        slot.deadline_ts = Some(ts);
    }
    let updated = slot.clone();

    let rev = todo_file::save(todos).map_err(from_todo_error)?;
    println!("已修改 #{}（rev {rev}）：{}", position + 1, describe(&updated));
    Ok(())
}

// ─────────────────────────── rm ───────────────────────────

fn cmd_rm(args: &[String]) -> Result<(), CliError> {
    let target = single_target(args, "rm")?;

    let mut todos = read_todos()?;
    let sorted = todo_file::sorted(&todos);
    let position = resolve_target(&sorted, &target)?;
    let target_id = sorted[position].id.clone();

    let before = todos.len();
    todos.retain(|todo| todo.id != target_id);
    if todos.len() == before {
        return Err(CliError::not_found(format!("找不到待办：{target}")));
    }
    let rev = todo_file::save(todos).map_err(from_todo_error)?;
    println!(
        "已删除 #{}（rev {rev}）：{}",
        position + 1,
        describe(&sorted[position])
    );
    Ok(())
}

// ─────────────────────────── clear ───────────────────────────

fn cmd_clear(args: &[String]) -> Result<(), CliError> {
    let mut only_done = false;
    for arg in args {
        match arg.as_str() {
            "--done" => only_done = true,
            other => {
                return Err(CliError::usage(format!(
                    "clear 不认识这个参数：{other}\n用法：infoboard-todo clear --done"
                )))
            }
        }
    }
    if !only_done {
        // 只提供"清已完成"这一种清理：整表清空太危险，要清就自己删文件
        return Err(CliError::usage(
            "必须显式指定 `--done`：只清除已完成的待办\n用法：infoboard-todo clear --done",
        ));
    }

    let todos = read_todos()?;
    let before = todos.len();
    let kept: Vec<TodoItem> = todos.into_iter().filter(|todo| !todo.completed).collect();
    let removed = before - kept.len();
    if removed == 0 {
        println!("没有已完成的待办，无需清理");
        return Ok(());
    }
    let rev = todo_file::save(kept).map_err(from_todo_error)?;
    println!("已清除 {removed} 条已完成的待办（rev {rev}）");
    Ok(())
}

// ─────────────────────────── apply（声明式同步） ───────────────────────────
//
// 与 add 的区别：`add` 是"再来一条"（每次新 id），`apply` 是"整表对齐到这份清单"。
// 外部来源（第三方待办 / 自己的脚本）都有稳定 id，反复同步靠 id 幂等；
// "这条在来源里消失了"用 `--prune` 前缀表达 —— 不给前缀就绝不删任何东西。

/// payload：`{"items": [...], "prune": ["前缀", ...]}`（`items` 缺失 = 空数组）
#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApplyPayload {
    #[serde(default)]
    items: Vec<todo_file::ApplyItem>,
    #[serde(default)]
    prune: Vec<String>,
}

/// apply 的结果 + 打印所需的两件额外信息（改之前的 rev、清单条数）
#[derive(Debug)]
struct ApplyOutcome {
    before_rev: u64,
    item_count: usize,
    report: todo_file::ApplyReport,
}

fn cmd_apply(args: &[String]) -> Result<(), CliError> {
    let mut file: Option<String> = None;
    let mut prune: Vec<String> = Vec::new();
    let mut dry_run = false;
    let mut json = false;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "-f" | "--file" => {
                let value = args
                    .get(i + 1)
                    .ok_or_else(|| CliError::usage("--file 后面要跟文件路径（不给就从 stdin 读）"))?;
                file = Some(value.clone());
                i += 2;
            }
            "--prune" => {
                let value = args.get(i + 1).ok_or_else(|| {
                    CliError::usage("--prune 后面要跟 id 前缀，例如 --prune cx-（可重复给多个）")
                })?;
                prune.push(value.clone());
                i += 2;
            }
            "--dry-run" => {
                dry_run = true;
                i += 1;
            }
            "--json" => {
                json = true;
                i += 1;
            }
            other => {
                return Err(CliError::usage(format!(
                    "apply 不认识这个参数：{other}\n用法：infoboard-todo apply [--file <path>] [--prune <前缀>]... [--dry-run] [--json]"
                )))
            }
        }
    }

    // 默认从 stdin 读：`脚本 | infoboard-todo apply` 是最顺手的用法
    let mut source: Box<dyn Read> = match &file {
        Some(path) => Box::new(
            std::fs::File::open(path)
                .map_err(|err| CliError::usage(format!("打开 {path} 失败：{err}")))?,
        ),
        None => Box::new(std::io::stdin()),
    };

    let data_path = todo_file::todo_path().map_err(from_todo_error)?;
    let outcome = apply_from_reader(&mut source, &data_path, &prune, dry_run)?;
    print_apply(&outcome, &data_path, json);
    Ok(())
}

/// 从任意 reader 读 payload → 校验 → 调数据层。**返回报告而不是自己打印**，
/// 单测就能用 `io::Cursor` 造输入、直接断言数字（不需要抓 stdout）。
fn apply_from_reader<R: Read>(
    source: &mut R,
    path: &Path,
    cli_prune: &[String],
    dry_run: bool,
) -> Result<ApplyOutcome, CliError> {
    let mut raw = String::new();
    source
        .read_to_string(&mut raw)
        .map_err(|err| CliError::usage(format!("读取输入失败：{err}")))?;
    let raw = raw.trim_start_matches('\u{feff}');
    // 空输入必须报错：当真成"空清单 + prune"就可能把整批来源条目删光
    if raw.trim().is_empty() {
        return Err(CliError::usage(
            "输入是空的\napply 需要一份 JSON 清单（默认从 stdin 读，或用 --file <path>）：\n  {\"items\":[{\"id\":\"a-1\",\"text\":\"写周报\",\"deadline\":\"2026-11-10\",\"completed\":false}],\"prune\":[\"a-\"]}",
        ));
    }
    let payload: ApplyPayload = serde_json::from_str(raw).map_err(|err| {
        CliError::usage(format!(
            "输入不是合法 JSON：{err}\n期望形状：\n  {{\"items\":[{{\"id\":\"a-1\",\"text\":\"写周报\",\"deadline\":\"2026-11-10\",\"completed\":false}}],\"prune\":[\"a-\"]}}"
        ))
    })?;

    // 逐条校验（数据层也会拦，但那边只能用 Corrupt，退出码会是 3；
    // 输入问题是用法问题，必须在 CLI 层判成 1）
    let now = chrono::Local::now();
    let mut seen: Vec<String> = Vec::with_capacity(payload.items.len());
    let mut items: Vec<todo_file::ApplyItem> = Vec::with_capacity(payload.items.len());
    for (index, item) in payload.items.iter().enumerate() {
        let id = item.id.trim();
        let text = item.text.trim();
        if id.is_empty() || text.is_empty() {
            return Err(CliError::usage(format!(
                "第 {} 条的 id / text 是空白（id = {:?}）\n每条都必须有非空 id 和非空 text",
                index + 1,
                item.id
            )));
        }
        if seen.iter().any(|known| known == id) {
            return Err(CliError::usage(format!(
                "items 里有重复 id：{id}\n（同一条不该出现两次：更新谁无法判断，整批不写）"
            )));
        }
        seen.push(id.to_string());

        // 日期在这里先归一化：非法直接 exit 1，不写文件
        let deadline = match item.deadline.as_deref() {
            None => None,
            Some(value) if value.trim().is_empty() => None,
            Some(value) => Some(
                todo_file::normalize_deadline(value, now)
                    .ok_or_else(|| {
                        CliError::usage(format!(
                            "无法识别的截止日期：{value}\n支持 `YYYY-MM-DD`（如 2027-01-05）或 `M月D日`（如 1月5日，取下一次出现的日期）\n整批未写入"
                        ))
                    })?
                    .0,
            ),
        };

        items.push(todo_file::ApplyItem {
            id: id.to_string(),
            text: text.to_string(),
            deadline,
            completed: item.completed,
        });
    }

    // prune = payload + 命令行（并集，去空白去重）；顺序只影响报错可读性
    let mut prune: Vec<String> = Vec::new();
    for prefix in payload.prune.iter().chain(cli_prune.iter()) {
        let prefix = prefix.trim();
        if prefix.is_empty() {
            continue;
        }
        if !prune.iter().any(|known| known == prefix) {
            prune.push(prefix.to_string());
        }
    }

    // 先读一次拿"改之前的 rev"：损坏在这里就会 exit 3，且一个字节都不会写
    let before_rev = todo_file::load_at(path).map_err(from_todo_error)?.rev;
    let report =
        todo_file::apply_at(path, &items, &prune, dry_run).map_err(from_todo_error)?;

    Ok(ApplyOutcome { before_rev, item_count: items.len(), report })
}

/// 打印 apply 结果（人类可读 / `--json`）
fn print_apply(outcome: &ApplyOutcome, data_path: &Path, json: bool) {
    let report = &outcome.report;

    if json {
        // 字段名固定给脚本用（camelCase）；dataPath 便于脚本确认改的是哪个文件
        let payload = ApplyJson {
            rev: report.rev,
            added: report.added,
            updated: report.updated,
            removed: report.removed,
            unchanged: report.unchanged,
            dry_run: report.dry_run,
            data_path: data_path.display().to_string(),
        };
        match serde_json::to_string_pretty(&payload) {
            Ok(text) => println!("{text}"),
            Err(err) => eprintln!("序列化输出失败：{err}"),
        }
        return;
    }

    // rev 变了 = 真的落盘了（dry-run 与"无变化"都不写，rev 原样返回）
    let written = report.rev != outcome.before_rev;
    let touched = report.added + report.updated + report.removed;
    let suffix = if report.dry_run { "（dry-run，未写入）" } else { "" };

    if !written && touched == 0 {
        println!("没有变化（rev {} 不变）{suffix}", report.rev);
        return;
    }
    let rev_part = if written {
        format!("rev {} → {}", outcome.before_rev, report.rev)
    } else {
        format!("rev {} 不变", report.rev)
    };
    println!(
        "读取 {} 条：新增 {}，更新 {}，删除 {}，未变 {}（{rev_part}）{suffix}",
        outcome.item_count, report.added, report.updated, report.removed, report.unchanged
    );
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ApplyJson {
    rev: u64,
    added: usize,
    updated: usize,
    removed: usize,
    unchanged: usize,
    dry_run: bool,
    data_path: String,
}

// ─────────────────────────── path / help ───────────────────────────

fn cmd_path(args: &[String]) -> Result<(), CliError> {
    if let Some(extra) = args.first() {
        return Err(CliError::usage(format!(
            "path 不接受参数：{extra}\n用法：infoboard-todo path"
        )));
    }
    let path = todo_file::todo_path().map_err(from_todo_error)?;
    println!("{}", path.display());
    Ok(())
}

fn print_help() {
    // 用 `{}` 而不是把正文直接当格式串：正文里有 JSON 示例（`{"items":…}`），
    // 花括号会被当成占位符
    println!(
        "{}",
        r#"infoboard-todo —— InfoBoard 待办命令行（数据文件与 app 共用：todo.json）

用法：
  infoboard-todo                                    等同于 list
  infoboard-todo list   [--all|--active|--done] [--json]
  infoboard-todo add    <文本...> [-d|--deadline <日期>]
  infoboard-todo done   <目标>
  infoboard-todo undone <目标>
  infoboard-todo edit   <目标> [-t|--text <新文本>] [-d|--deadline <日期>|--clear-deadline]
  infoboard-todo rm     <目标>
  infoboard-todo clear  --done
  infoboard-todo apply  [--file <path>] [--prune <前缀>]... [--dry-run] [--json]
  infoboard-todo path
  infoboard-todo help

<目标>：
  · 纯数字 = 当前列表里的序号（1 基，就是 `list` 显示的那个序号，未完成在前）
  · 其它 = 待办 id 的前缀（不区分大小写）；前缀不唯一会报错并列出候选

apply（声明式同步，给脚本 / 外部来源用）：
  · 用法：给一份**完整清单**，把 todo.json 对齐成清单的样子
  · 靠 id 幂等：同 id 的条目走更新而不是再新增一条，同一份清单反复跑结果一致；
    清单里没有变化时**不写盘、rev 不变**
  · 靠前缀安全删：只删"id 以 --prune 前缀开头 **并且** 这次清单里没给"的条目
    （可给多个前缀）；**不给 --prune 就一条都不删**
  · 只保留"完成"状态，不降级：文件里已完成（true）的条目，清单说 false 也不会被改回未完成
  · 输入默认从 stdin 读，也可 --file <path>：
      {"items":[{"id":"a-1","text":"写周报","deadline":"2026-11-10","completed":false}],
       "prune":["a-"]}
    payload 里的 prune 与命令行 --prune 取并集；items 缺失按空数组
  · --dry-run 只报数不写盘；--json 输出 {"rev":…,"added":…,"updated":…,"removed":…,
    "unchanged":…,"dryRun":…,"dataPath":"…"}
  · 退出码：0 成功（含无变化）/ 1 输入不是合法 JSON、缺字段、重复 id、日期非法 /
    3 数据文件损坏

<日期>：
  · YYYY-MM-DD   严格校验（2026-02-30 非法，2028-02-29 合法）
  · M月D日        "下一次出现"规则（今天已过就用明年），落盘时会归一化成 ISO
  · 时区取本地；截止时刻是当天 23:59:59.999，当天不算逾期

排序（与 app 完全一致）：
  未完成在前；组内按截止时间升序；没有截止时间的按创建时间降序。

输出：
  默认中文人可读，逾期用 `! 日期（已逾期）` 标记；`--json` 输出机器可读 JSON。

数据位置：
  %APPDATA%\com.infoboard.tauri\todo.json
  用环境变量 INFOBOARD_DATA_DIR 可以覆盖数据目录（测试 / 绿色版 / 脚本用）。

中文乱码：
  旧版 Windows 控制台默认不是 UTF-8，中文可能显示为乱码 —— 先执行 `chcp 65001`
  （PowerShell 7 与 Windows Terminal 默认 UTF-8，无需处理）。

退出码：0 成功 / 1 用法或参数错误 / 2 找不到目标 / 3 数据文件损坏"#
    );
}

// ─────────────────────────── 目标解析 ───────────────────────────

/// `<目标>` → 排序列表里的下标
///
/// 纯数字按 1 基序号；否则按 id 前缀匹配（大小写不敏感），不唯一时报错并列出候选。
fn resolve_target(sorted: &[TodoItem], target: &str) -> Result<usize, CliError> {
    let target = target.trim();
    if target.is_empty() {
        return Err(CliError::usage("目标不能为空"));
    }

    if target.bytes().all(|b| b.is_ascii_digit()) {
        let index: usize = target.parse().map_err(|_| {
            CliError::not_found(format!("序号 {target} 超出范围（共 {} 条待办）", sorted.len()))
        })?;
        if index == 0 || index > sorted.len() {
            return Err(CliError::not_found(format!(
                "序号 {index} 超出范围（共 {} 条待办）",
                sorted.len()
            )));
        }
        return Ok(index - 1);
    }

    let needle = target.to_ascii_lowercase();
    let hits: Vec<usize> = sorted
        .iter()
        .enumerate()
        .filter(|(_, todo)| todo.id.to_ascii_lowercase().starts_with(&needle))
        .map(|(index, _)| index)
        .collect();

    match hits.len() {
        0 => Err(CliError::not_found(format!(
            "找不到待办：{target}\n（用 `infoboard-todo list` 看序号和 id）"
        ))),
        1 => Ok(hits[0]),
        _ => {
            let mut message = format!("id 前缀 {target} 不唯一，候选：");
            for index in &hits {
                message.push_str(&format!("\n  {}  {}", index + 1, describe(&sorted[*index])));
            }
            Err(CliError::usage(message))
        }
    }
}

/// 单目标命令（done / undone / rm）的参数校验
fn single_target(args: &[String], command: &str) -> Result<String, CliError> {
    match args.len() {
        1 => Ok(args[0].clone()),
        0 => Err(CliError::usage(format!(
            "缺少目标\n用法：infoboard-todo {command} <目标>（纯数字序号 或 id 前缀）"
        ))),
        _ => Err(CliError::usage(format!(
            "只接受一个目标，收到 {} 个：{}\n用法：infoboard-todo {command} <目标>",
            args.len(),
            args.join(" ")
        ))),
    }
}

/// 单行描述一条待办（打印用）
fn describe(todo: &TodoItem) -> String {
    let mark = if todo.completed { "✓" } else { "○" };
    match (&todo.deadline, todo.completed) {
        (_, true) => format!("{mark} {} (已完成)", todo.text),
        (Some(deadline), false) => format!("{mark} {}  {deadline}", todo.text),
        (None, false) => format!("{mark} {}", todo.text),
    }
}

// ─────────────────────────── 单测 ───────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn todo(id: &str, text: &str, completed: bool, deadline_ts: Option<i64>, created_at: i64) -> TodoItem {
        TodoItem {
            id: id.to_string(),
            text: text.to_string(),
            completed,
            deadline: deadline_ts.map(|_| "2027-01-05".to_string()),
            deadline_ts,
            created_at,
        }
    }

    // ─── 7. 目标解析 ───

    #[test]
    fn numeric_target_is_one_based() {
        let sorted = vec![todo("a1", "第一条", false, None, 1), todo("b2", "第二条", false, None, 2)];
        assert_eq!(resolve_target(&sorted, "1").unwrap(), 0);
        assert_eq!(resolve_target(&sorted, "2").unwrap(), 1);
        // 越界 / 0 都是"找不到"
        assert_eq!(resolve_target(&sorted, "3").unwrap_err().code, EXIT_NOT_FOUND);
        assert_eq!(resolve_target(&sorted, "0").unwrap_err().code, EXIT_NOT_FOUND);
        assert_eq!(resolve_target(&sorted, "").unwrap_err().code, EXIT_USAGE);
    }

    #[test]
    fn id_prefix_matches_uniquely() {
        let sorted = vec![todo("m9k2abc", "买牛奶", false, None, 1), todo("zzz999", "交房租", false, None, 2)];
        assert_eq!(resolve_target(&sorted, "m9k").unwrap(), 0);
        assert_eq!(resolve_target(&sorted, "m9k2abc").unwrap(), 0);
        // 大小写不敏感
        assert_eq!(resolve_target(&sorted, "ZZZ").unwrap(), 1);
        assert_eq!(resolve_target(&sorted, "nope").unwrap_err().code, EXIT_NOT_FOUND);
    }

    #[test]
    fn ambiguous_prefix_lists_candidates() {
        let sorted = vec![todo("m9k2aaa", "买牛奶", false, None, 1), todo("m9k2bbb", "交房租", false, None, 2)];
        let err = resolve_target(&sorted, "m9k").unwrap_err();
        assert_eq!(err.code, EXIT_USAGE, "前缀不唯一属于用法错误");
        assert!(err.message.contains("不唯一"), "{}", err.message);
        assert!(err.message.contains("买牛奶"), "{}", err.message);
        assert!(err.message.contains("交房租"), "{}", err.message);
    }

    // ─── 排序 + 序号必须与 app 一致 ───

    #[test]
    fn numeric_target_follows_app_order() {
        let todos = vec![
            todo("done1", "已完成", true, Some(1), 1),
            todo("nodl", "无截止", false, None, 1),
            todo("early", "早到期", false, Some(100), 1),
        ];
        let sorted = todo_file::sorted(&todos);
        // 序号 1 必须是"早到期"（排序第一条），而不是文件里的第一条
        assert_eq!(resolve_target(&sorted, "1").unwrap(), 0);
        assert_eq!(sorted[0].id, "early");
        assert_eq!(sorted[1].id, "nodl");
        assert_eq!(sorted[2].id, "done1");
    }

    #[test]
    fn width_helpers_do_not_panic_on_mixed_width() {
        assert_eq!(display_width("abc"), 3);
        assert_eq!(display_width("买牛奶"), 6);
        assert_eq!(display_width("买a"), 3);
        let rows = vec![
            (1, todo("a", "买牛奶", false, None, 1)),
            (2, todo("b", "ok", true, None, 2)),
        ];
        // 只验证不 panic（输出格式靠人眼核对）
        print_rows(&rows, 0);
    }

    #[test]
    fn overdue_and_done_rows_render_expected_tail() {
        let active = todo("a", "过期了", false, Some(1_000), 1);
        assert!(tail_text(&active, 2_000).starts_with('!'));
        assert!(tail_text(&active, 500).contains("2027-01-05"));
        let done = todo("b", "完成了", true, Some(1_000), 1);
        assert_eq!(tail_text(&done, 2_000), "(已完成)");
        let plain = TodoItem {
            id: "c".into(),
            text: "无期限".into(),
            completed: false,
            deadline: None,
            deadline_ts: None,
            created_at: 1,
        };
        assert_eq!(tail_text(&plain, 2_000), "");
    }

    // ─── apply（声明式同步） ───

    fn cli_temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "infoboard-todo-cli-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 合法 stdin → 报告数字对；同一份 payload 再跑一次必须是"没有变化"
    #[test]
    fn apply_from_reader_reports_numbers_and_is_idempotent() {
        let dir = cli_temp_dir("applyok");
        let path = todo_file::todo_path_in(&dir);
        let body = r#"{"items":[
            {"id":"cx-0001","text":"甲","deadline":"2026-11-10","completed":false},
            {"id":"cx-0002","text":"乙","completed":true},
            {"id":"cx-0003","text":"丙"}
        ],"prune":["cx-"]}"#;

        let mut source = std::io::Cursor::new(body.as_bytes().to_vec());
        let outcome = apply_from_reader(&mut source, &path, &[], false).unwrap();
        assert_eq!(outcome.item_count, 3);
        assert_eq!(outcome.before_rev, 0);
        assert_eq!(
            (outcome.report.added, outcome.report.updated, outcome.report.removed, outcome.report.unchanged),
            (3, 0, 0, 0)
        );
        assert_eq!(outcome.report.rev, 1);
        assert!(!outcome.report.dry_run);

        // 同一份 payload 再来一次：全"未变"，rev 不动
        let mut again = std::io::Cursor::new(body.as_bytes().to_vec());
        let outcome = apply_from_reader(&mut again, &path, &[], false).unwrap();
        assert_eq!(outcome.report.unchanged, 3);
        assert_eq!(outcome.report.rev, outcome.before_rev, "无变化不许涨 rev");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 重复 id 属于用法错误（exit 1），且一个字节都不写
    #[test]
    fn apply_rejects_duplicate_ids_at_cli_layer() {
        let dir = cli_temp_dir("applydup");
        let path = todo_file::todo_path_in(&dir);
        let body = r#"{"items":[
            {"id":"cx-0001","text":"甲"},
            {"id":"cx-0001","text":"乙"}
        ]}"#;

        let mut source = std::io::Cursor::new(body.as_bytes().to_vec());
        let err = apply_from_reader(&mut source, &path, &[], false).unwrap_err();
        assert_eq!(err.code, EXIT_USAGE, "重复 id 是用法错误，不是数据损坏");
        assert!(err.message.contains("重复 id"), "{}", err.message);
        assert!(!path.exists(), "输入有问题时不许创建文件");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// payload 里的 prune 与命令行 --prune 取并集
    #[test]
    fn apply_prune_is_union_of_payload_and_cli() {
        let dir = cli_temp_dir("applyunion");
        let path = todo_file::todo_path_in(&dir);

        let seed = r#"{"items":[
            {"id":"cx-1","text":"来源甲"},
            {"id":"hw-1","text":"来源乙"},
            {"id":"keep-1","text":"保留"}
        ]}"#;
        let mut source = std::io::Cursor::new(seed.as_bytes().to_vec());
        apply_from_reader(&mut source, &path, &[], false).unwrap();

        // payload 给 cx-，命令行给 hw- → 两条都该被删，keep-1 留下
        let body = r#"{"items":[{"id":"keep-1","text":"保留"}],"prune":["cx-"]}"#;
        let mut source = std::io::Cursor::new(body.as_bytes().to_vec());
        let outcome =
            apply_from_reader(&mut source, &path, &["hw-".to_string()], false).unwrap();
        assert_eq!(outcome.report.removed, 2, "两个前缀各自命中一条");
        assert_eq!(outcome.report.unchanged, 1);
        assert_eq!(outcome.report.rev, outcome.before_rev + 1);

        let ids: Vec<String> =
            todo_file::load_at(&path).unwrap().todos.into_iter().map(|t| t.id).collect();
        assert_eq!(ids, vec!["keep-1"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 空输入 / 非法 JSON / 非法日期 / 空 text 一律 exit 1，且不碰数据文件
    #[test]
    fn apply_rejects_bad_input_before_writing() {
        let dir = cli_temp_dir("applybad");
        let path = todo_file::todo_path_in(&dir);

        let cases: [(&str, &str); 5] = [
            ("   \n", "空输入"),
            ("[{oops", "非法 JSON"),
            (r#"{"items":[{"id":"x","text":"甲","deadline":"2026-02-30"}]}"#, "非法日期"),
            (r#"{"items":[{"id":"x","text":"   "}]}"#, "空 text"),
            (r#"{"items":[{"text":"没有 id"}]}"#, "缺 id"),
        ];
        for (body, why) in cases {
            let mut source = std::io::Cursor::new(body.as_bytes().to_vec());
            let err = apply_from_reader(&mut source, &path, &[], false).unwrap_err();
            assert_eq!(err.code, EXIT_USAGE, "{why} 应是用法错误：{}", err.message);
            assert!(!path.exists(), "{why} 时不许写盘");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
