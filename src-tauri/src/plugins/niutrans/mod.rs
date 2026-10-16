//! 小牛翻译插件
//!
//! 官方 v2：POST https://api.niutrans.com/v2/text/translate
//! body: { from, to, srcText, appId, timestamp, authStr }
//! authStr = md5( 参数按 key 字典序 key=value&... ，签名时含 apikey )

use md5::{Digest, Md5};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

mod types;
use types::*;

const STORE_PATH: &str = "niutrans.json";
const STORE_KEY_APP_ID: &str = "appId";
const STORE_KEY_API_KEY: &str = "apiKey";
const STORE_KEY_CHAR_COUNT: &str = "charCount";

const API_V2: &str = "https://api.niutrans.com/v2/text/translate";
const API_LEGACY: &str = "https://api.niutrans.com/NiuTransServer/translation";

// ─── Store ───

fn read_field(app: &AppHandle, key: &str) -> Result<String, String> {
    let store = app
        .store(STORE_PATH)
        .map_err(|e| format!("打开配置失败: {e}"))?;
    Ok(store
        .get(key)
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .unwrap_or_default())
}

fn write_field(app: &AppHandle, key: &str, value: &str) -> Result<(), String> {
    let store = app
        .store(STORE_PATH)
        .map_err(|e| format!("打开配置失败: {e}"))?;
    store.set(key, serde_json::json!(value));
    store
        .save()
        .map_err(|e| format!("保存配置失败: {e}"))?;
    Ok(())
}

fn read_char_count(app: &AppHandle) -> Result<u64, String> {
    let store = app
        .store(STORE_PATH)
        .map_err(|e| format!("打开配置失败: {e}"))?;
    Ok(store
        .get(STORE_KEY_CHAR_COUNT)
        .and_then(|v| v.as_u64())
        .unwrap_or(0))
}

fn add_char_count(app: &AppHandle, n: u64) -> Result<(), String> {
    let store = app
        .store(STORE_PATH)
        .map_err(|e| format!("打开配置失败: {e}"))?;
    let cur = store
        .get(STORE_KEY_CHAR_COUNT)
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    store.set(STORE_KEY_CHAR_COUNT, serde_json::json!(cur + n));
    store
        .save()
        .map_err(|e| format!("保存配置失败: {e}"))?;
    Ok(())
}

fn mask_secret(s: &str) -> String {
    if s.is_empty() {
        return String::new();
    }
    let prefix: String = s.chars().take(4).collect();
    format!("{prefix}***")
}

// ─── 签名 ───

fn md5_hex(input: &str) -> String {
    let mut hasher = Md5::new();
    hasher.update(input.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// 小牛 v2 authStr
fn make_auth_str(params: &BTreeMap<String, String>) -> String {
    let s: String = params
        .iter()
        .filter(|(_, v)| !v.is_empty())
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("&");
    md5_hex(&s)
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 只认用户显式配置的环境变量代理；没有就直连。
/// 不再硬编码 127.0.0.1:7897/7890：没跑 Clash 的机器上会必然 Connection refused，
/// 端口被别的服务占用时请求还会被转发给未知进程。
/// 逻辑统一在 `core::net`（原先这里是 `http_proxy.rs` 的重复实现，测试也在那边）。
fn proxy_from_env() -> Option<String> {
    crate::core::net::env_proxy()
}

fn build_client() -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(10))
        .user_agent("InfoBoard/0.1");

    if let Some(p) = proxy_from_env() {
        let proxy = reqwest::Proxy::all(&p).map_err(|e| format!("代理无效 ({p}): {e}"))?;
        builder = builder.proxy(proxy);
    }

    builder
        .build()
        .map_err(|e| format!("HTTP 客户端创建失败: {e}"))
}

// ─── 翻译 ───

async fn translate_v2(
    client: &reqwest::Client,
    app_id: &str,
    api_key: &str,
    text: &str,
    from: &str,
    to: &str,
) -> Result<String, String> {
    let timestamp = now_unix();
    let mut sign_params = BTreeMap::new();
    sign_params.insert("appId".into(), app_id.to_string());
    sign_params.insert("apikey".into(), api_key.to_string());
    sign_params.insert("from".into(), from.to_string());
    sign_params.insert("srcText".into(), text.to_string());
    sign_params.insert("timestamp".into(), timestamp.to_string());
    sign_params.insert("to".into(), to.to_string());

    let auth_str = make_auth_str(&sign_params);

    let body = serde_json::json!({
        "from": from,
        "to": to,
        "srcText": text,
        "appId": app_id,
        "timestamp": timestamp,
        "authStr": auth_str,
    });

    let resp = client
        .post(API_V2)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("网络请求失败: {e}"))?;

    let status = resp.status();
    let raw = resp
        .text()
        .await
        .map_err(|e| format!("读取响应失败: {e}"))?;

    if !status.is_success() {
        return Err(format!(
            "HTTP {}: {}",
            status.as_u16(),
            raw.chars().take(160).collect::<String>()
        ));
    }

    let v: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("JSON 解析失败: {e}"))?;

    if let Some(t) = v
        .get("tgtText")
        .or_else(|| v.get("tgt_text"))
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
    {
        return Ok(t.to_string());
    }

    let code = v
        .get("errorCode")
        .or_else(|| v.get("error_code"))
        .or_else(|| v.get("code"))
        .and_then(|x| x.as_str().map(|s| s.to_string()).or_else(|| x.as_i64().map(|n| n.to_string())))
        .unwrap_or_else(|| "?".into());
    let msg = v
        .get("errorMsg")
        .or_else(|| v.get("error_msg"))
        .or_else(|| v.get("message"))
        .and_then(|x| x.as_str())
        .unwrap_or("未知错误");
    Err(format!("小牛翻译错误 [{code}]: {msg}"))
}

async fn translate_legacy(
    client: &reqwest::Client,
    api_key: &str,
    text: &str,
    from: &str,
    to: &str,
) -> Result<String, String> {
    let body = serde_json::json!({
        "from": from,
        "to": to,
        "apikey": api_key,
        "src_text": text,
    });

    let resp = client
        .post(API_LEGACY)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("网络请求失败: {e}"))?;

    let raw = resp
        .text()
        .await
        .map_err(|e| format!("读取响应失败: {e}"))?;

    let v: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("JSON 解析失败: {e}"))?;

    if let Some(code) = v.get("error_code").and_then(|x| x.as_str()) {
        if code != "0" && !code.is_empty() {
            let msg = v
                .get("error_msg")
                .and_then(|x| x.as_str())
                .unwrap_or("未知错误");
            return Err(format!("小牛翻译错误 [{code}]: {msg}"));
        }
    }

    if let Some(t) = v
        .get("tgt_text")
        .or_else(|| v.get("tgtText"))
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
    {
        return Ok(t.to_string());
    }

    Err(format!(
        "响应无法解析: {}",
        raw.chars().take(200).collect::<String>()
    ))
}

// ─── Commands（保持与 bridge.ts / lib.rs 一致）───

#[tauri::command]
pub async fn niutrans_set_api_key(app: AppHandle, key: String) -> Result<(), String> {
    write_field(&app, STORE_KEY_API_KEY, key.trim())
}

#[tauri::command]
pub async fn niutrans_set_app_id(app: AppHandle, app_id: String) -> Result<(), String> {
    write_field(&app, STORE_KEY_APP_ID, app_id.trim())
}

#[tauri::command]
pub async fn niutrans_has_api_key(app: AppHandle) -> Result<bool, String> {
    let key = read_field(&app, STORE_KEY_API_KEY)?;
    Ok(!key.is_empty())
}

#[tauri::command]
pub async fn niutrans_get_config(app: AppHandle) -> Result<TranslateConfig, String> {
    let app_id = read_field(&app, STORE_KEY_APP_ID)?;
    let api_key = read_field(&app, STORE_KEY_API_KEY)?;
    Ok(TranslateConfig {
        has_key: !api_key.is_empty(),
        app_id: mask_secret(&app_id),
        api_key_mask: mask_secret(&api_key),
    })
}

#[tauri::command]
pub async fn niutrans_get_char_count(app: AppHandle) -> Result<u64, String> {
    read_char_count(&app)
}

#[tauri::command]
pub async fn niutrans_translate(
    app: AppHandle,
    text: String,
    from: String,
    to: String,
) -> Result<TranslateResult, String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("翻译文本不能为空".into());
    }
    if text.chars().count() > 5000 {
        return Err("单次翻译不能超过 5000 字符".into());
    }

    let api_key = read_field(&app, STORE_KEY_API_KEY)?;
    if api_key.is_empty() {
        return Err("未配置小牛翻译 API Key（设置 → 小牛翻译）".into());
    }
    let app_id = read_field(&app, STORE_KEY_APP_ID)?;

    let client = build_client()?;
    crate::core::app_log::emit(
        &app,
        "info",
        &format!(
            "[niutrans] 翻译 {}→{} len={} hasAppId={}",
            from,
            to,
            text.chars().count(),
            !app_id.is_empty()
        ),
    );

    let translated = if !app_id.is_empty() {
        match translate_v2(&client, &app_id, &api_key, &text, &from, &to).await {
            Ok(t) => t,
            Err(e) => {
                crate::core::app_log::emit(
                    &app,
                    "warn",
                    &format!("[niutrans] v2 失败，尝试 legacy: {e}"),
                );
                translate_legacy(&client, &api_key, &text, &from, &to)
                    .await
                    .map_err(|e2| format!("{e} | legacy: {e2}"))?
            }
        }
    } else {
        // 无 appId：先 legacy，再提示
        translate_legacy(&client, &api_key, &text, &from, &to)
            .await
            .map_err(|e| {
                format!("{e}（若你使用签名版 Key，请在设置中同时填写 App ID）")
            })?
    };

    let _ = add_char_count(&app, text.chars().count() as u64);
    crate::core::app_log::emit(
        &app,
        "info",
        &format!(
            "[niutrans] 成功 out_len={}",
            translated.chars().count()
        ),
    );

    Ok(TranslateResult {
        text: translated,
        from,
        to,
    })
}

// ─── 测试 ───

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pick_proxy_uses_first_non_empty() {
        // 代理选择的纯函数已统一到 core::net，这里只做冒烟检查
        assert_eq!(
            crate::core::net::pick_proxy([None, Some("  ".into()), Some("http://p:1".into())])
                .as_deref(),
            Some("http://p:1")
        );
    }

    /// 回归：没有任何环境变量代理时必须直连，不能凭空返回本地 Clash 端口
    #[test]
    fn pick_proxy_none_means_direct() {
        assert_eq!(crate::core::net::pick_proxy([None, None, Some("".into())]), None);
        assert_eq!(crate::core::net::pick_proxy(Vec::<Option<String>>::new()), None);
    }

    #[test]
    fn test_auth_str_stable() {
        let mut p = BTreeMap::new();
        p.insert("appId".into(), "id1".into());
        p.insert("apikey".into(), "key1".into());
        p.insert("from".into(), "en".into());
        p.insert("srcText".into(), "hi".into());
        p.insert("timestamp".into(), "100".into());
        p.insert("to".into(), "zh".into());
        let s1 = make_auth_str(&p);
        let s2 = make_auth_str(&p);
        assert_eq!(s1, s2);
        assert_eq!(s1.len(), 32);
        // 拼接串固定
        let expected = md5_hex("apikey=key1&appId=id1&from=en&srcText=hi&timestamp=100&to=zh");
        assert_eq!(s1, expected);
    }

    #[test]
    fn test_auth_skips_empty() {
        let mut p = BTreeMap::new();
        p.insert("a".into(), "1".into());
        p.insert("b".into(), "".into());
        p.insert("c".into(), "3".into());
        assert_eq!(make_auth_str(&p), md5_hex("a=1&c=3"));
    }
}
