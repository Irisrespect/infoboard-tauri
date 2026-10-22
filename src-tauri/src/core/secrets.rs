//! 凭据存储（Windows 凭据管理器）
//!
//! 所有 API Key 都放这里，不再明文写进 `tauri-plugin-store` 的 json 或
//! 前端 `localStorage`。
//!
//! 原则：**凭据库不可用时返回明确错误，绝不回退到明文存储。**
//!
//! 凭据名走白名单，避免前端（含外部插件，它们跑在主窗口里）往系统凭据库里
//! 塞任意条目。

use keyring::Entry;

/// 服务名固定，凭据管理器里显示为 `com.infoboard.tauri`
pub const SERVICE: &str = "com.infoboard.tauri";

/// 和风天气 API Key
pub const NAME_QWEATHER: &str = "qweather";
/// 小牛翻译 API Key
pub const NAME_NIUTRANS: &str = "niutrans";
/// OpenAI 兼容翻译引擎的 Key（翻译插件用）
pub const NAME_TRANSLATE_OPENAI: &str = "translate-openai";
/// DeepL 翻译 Key（翻译插件用）
pub const NAME_TRANSLATE_DEEPL: &str = "translate-deepl";

/// 允许访问的凭据名（前端只能操作这些）
pub const ALLOWED_NAMES: &[&str] = &[
    NAME_QWEATHER,
    NAME_NIUTRANS,
    NAME_TRANSLATE_OPENAI,
    NAME_TRANSLATE_DEEPL,
];

fn entry(name: &str) -> Result<Entry, String> {
    if !ALLOWED_NAMES.contains(&name) {
        return Err(format!("未知的凭据名: {name}"));
    }
    Entry::new(SERVICE, name).map_err(|e| format!("打开凭据库失败: {e}"))
}

/// 写入（已存在则覆盖）
pub fn set(name: &str, value: &str) -> Result<(), String> {
    let entry = entry(name)?;
    entry
        .set_password(value)
        .map_err(|e| format!("写入凭据管理器失败: {e}"))
}

/// 读取；`Ok(None)` 表示尚未配置
pub fn get(name: &str) -> Result<Option<String>, String> {
    match entry(name)?.get_password() {
        Ok(password) => Ok(Some(password)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("读取凭据管理器失败: {e}")),
    }
}

/// 是否存在（空串视为不存在）
pub fn has(name: &str) -> Result<bool, String> {
    Ok(get(name)?.map(|v| !v.trim().is_empty()).unwrap_or(false))
}

/// 删除；不存在时也算成功
pub fn delete(name: &str) -> Result<(), String> {
    match entry(name)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("删除凭据失败: {e}")),
    }
}

// ─── Tauri Commands ───
//
// 只提供 set / has / delete，**不提供 get**：前端永远拿不到明文 Key，
// 请求时由 Rust 侧替换占位符（见 core::http_proxy 与 plugins::niutrans）。

#[tauri::command]
pub async fn secret_set(name: String, value: String) -> Result<(), String> {
    let value = value.trim().to_string();
    // 传空值 = 删除，避免存一个空字符串让 has() 语义混乱
    if value.is_empty() {
        return delete(&name);
    }
    set(&name, &value)
}

#[tauri::command]
pub async fn secret_has(name: String) -> Result<bool, String> {
    has(&name)
}

#[tauri::command]
pub async fn secret_delete(name: String) -> Result<(), String> {
    delete(&name)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 白名单外的名字必须被拒绝（前端 / 外部插件不能乱写凭据库）
    #[test]
    fn unknown_name_is_rejected() {
        let err = entry("qweather-evil").unwrap_err();
        assert!(err.contains("未知的凭据名"), "{err}");
        let err = set("", "x").unwrap_err();
        assert!(err.contains("未知的凭据名"), "{err}");
    }

    #[test]
    fn allowed_names_are_accepted() {
        for name in ALLOWED_NAMES {
            assert!(entry(name).is_ok(), "应接受白名单名字: {name}");
        }
    }

    /// 回归：凭据必须**跨进程重启**可读（这是"重启后 Key 消失"的核心不变量）。
    ///
    /// 用 `niutrans` 这个名字（白名单内的另一个名字，不影响天气 Key），
    /// 写一个探针值后**再去读一次**。Windows 凭据管理器的写入是同步落盘的，
    /// 所以"写完立刻读得到"就意味着重启后依然在 —— 反过来，一旦有人把
    /// `SERVICE` / 名字常量改掉，或把持久化写成 Session 级，这个测试就会失败。
    ///
    /// 默认跳过（会临时覆盖同名真实凭据）：
    /// `$env:INFOBOARD_KEYRING_TEST=1; cargo test`
    #[test]
    fn credential_survives_process_restart_when_enabled() {
        if std::env::var("INFOBOARD_KEYRING_TEST").ok().as_deref() != Some("1") {
            eprintln!("跳过：未设置 INFOBOARD_KEYRING_TEST=1（该用例会覆盖真实凭据）");
            return;
        }

        const NAME: &str = NAME_NIUTRANS;
        let original = get(NAME).expect("凭据库不可用");
        let probe = format!("infoboard-persist-{}", std::process::id());

        // 写
        set(NAME, &probe).expect("写入凭据失败");

        // 用一个**全新的 Entry** 读（模拟重启后重新打开凭据库，不复用任何缓存）
        let fresh = Entry::new(SERVICE, NAME).expect("重新打开凭据库失败");
        let read_back = fresh
            .get_password()
            .expect("重启后应能读到凭据（若这里失败说明凭据没真正落盘）");
        assert_eq!(read_back, probe, "跨进程读回的值必须一致");

        // 名字/服务名是对外契约：改了会让老用户的 Key「凭空消失」
        assert_eq!(SERVICE, "com.infoboard.tauri");
        assert_eq!(NAME_QWEATHER, "qweather");

        // 还原
        match original {
            Some(v) => set(NAME, &v).unwrap(),
            None => delete(NAME).unwrap(),
        }
    }

    /// 只读探针：报告真实凭据的可读性与大致长度，**不写入、不覆盖任何东西**。
    ///
    /// 用于排查"设置里显示已配置、但重启后天气说没配"这类问题：
    /// 能区分"凭据真的不存在"和"存在但读不出来/读出来是空串"。
    ///
    /// ```powershell
    /// $env:INFOBOARD_SECRETS_PROBE=1; cargo test secrets::tests::probe -- --nocapture
    /// ```
    #[test]
    fn probe_when_enabled() {
        if std::env::var("INFOBOARD_SECRETS_PROBE").ok().as_deref() != Some("1") {
            eprintln!("跳过：未设置 INFOBOARD_SECRETS_PROBE=1");
            return;
        }

        for name in ALLOWED_NAMES {
            match get(name) {
                Ok(Some(v)) => eprintln!(
                    "[probe] {name}: 存在，长度 {} 字符（首尾空白={:?}）",
                    v.chars().count(),
                    v.trim() != v.as_str()
                ),
                Ok(None) => eprintln!("[probe] {name}: 凭据不存在（NoEntry）"),
                Err(e) => eprintln!("[probe] {name}: 读取失败 → {e}"),
            }
            match has(name) {
                Ok(b) => eprintln!("[probe] {name}: has() = {b}"),
                Err(e) => eprintln!("[probe] {name}: has() 失败 → {e}"),
            }
        }
    }

    /// 真机凭据库往返（写→读→删）。
    ///
    /// 默认**跳过**：它会临时覆盖同名真实凭据（跑测试的机器上可能真配了 Key），
    /// 需要显式开启（与 OCR 测试的 FAKE_OCR_EXE 同一套路）：
    /// `$env:INFOBOARD_KEYRING_TEST=1; cargo test`
    #[test]
    fn roundtrip_when_enabled() {
        if std::env::var("INFOBOARD_KEYRING_TEST").ok().as_deref() != Some("1") {
            eprintln!("跳过：未设置 INFOBOARD_KEYRING_TEST=1（该用例会覆盖真实凭据）");
            return;
        }

        const NAME: &str = NAME_QWEATHER;
        let original = get(NAME).expect("凭据库不可用");
        let expected = original.clone();
        let probe = format!("infoboard-test-{}", std::process::id());

        set(NAME, &probe).expect("写入凭据失败");
        assert_eq!(get(NAME).unwrap().as_deref(), Some(probe.as_str()));
        assert!(has(NAME).unwrap());

        // 还原原值（或删掉测试条目）
        match original {
            Some(v) => set(NAME, &v).unwrap(),
            None => delete(NAME).unwrap(),
        }
        assert_eq!(get(NAME).unwrap(), expected, "测试后必须还原");
    }
}
