//! 通用在线翻译 —— 供外部插件 `plugins/translate` 调用的多引擎后端
//!
//! 为什么需要这一层：外部插件跑在 WebView 里，受 `tauri.conf.json` 的 CSP
//! `connect-src` 白名单限制，**发不出**对 DeepL / OpenAI / Google 的请求；
//! 插件侧也没有任何通用 HTTP 命令可用。所以"多引擎 + 免 Key 兜底"只能落在
//! Rust 侧：这里用 reqwest 直连，CSP 与它无关。
//!
//! 分工：
//! - `niutrans`（小牛）保留原来的 `niutrans_translate` 命令，不在这里重复实现；
//! - 本模块只负责 `openai` / `deepl` / `google` / `mymemory`。
//!
//! Key 的处理与 `niutrans` 一致：**永远不进前端**。前端只用 `secret_has` 查
//! 有没有配过，请求时由这里从 Windows 凭据管理器读出来。
//!
//! 代理：只认用户显式配置的环境变量，没有就直连（见 `core::net`）。

use std::time::Duration;
use tauri::AppHandle;

use crate::core::secrets;

/// 单次请求的文本上限。前端会先分片，这里只做硬护栏。
const MAX_CHARS: usize = 20_000;
const TIMEOUT: Duration = Duration::from_secs(30);

const DEFAULT_OPENAI_BASE: &str = "https://api.openai.com/v1";
const DEFAULT_OPENAI_MODEL: &str = "gpt-4o-mini";
const DEEPL_FREE_HOST: &str = "https://api-free.deepl.com";
const DEEPL_PRO_HOST: &str = "https://api.deepl.com";
const GOOGLE_URL: &str = "https://translate.googleapis.com/translate_a/single";
const MYMEMORY_URL: &str = "https://api.mymemory.translated.net/get";

/// 翻译结果（返回给插件）
#[derive(Debug, Clone, serde::Serialize)]
pub struct WebTranslateOut {
    /// 译文
    pub text: String,
    /// 实际使用的源语言（`auto` 时由引擎自行判断）
    pub from: String,
    /// 目标语言
    pub to: String,
    /// 实际应答的引擎名，便于界面显示"这一条是谁翻的"
    pub engine: String,
}

// ─── 工具 ───

fn build_client() -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .connect_timeout(Duration::from_secs(10))
        .user_agent("InfoBoard/0.8 (translate-plugin)");

    if let Some(p) = crate::core::net::env_proxy() {
        let proxy = reqwest::Proxy::all(&p).map_err(|e| format!("代理无效 ({p}): {e}"))?;
        builder = builder.proxy(proxy);
    }

    builder
        .build()
        .map_err(|e| format!("HTTP 客户端创建失败: {e}"))
}

fn truncate_for_error(raw: &str) -> String {
    raw.chars().take(200).collect()
}

/// 语言代码 → 人类可读名（给 LLM 的提示词用）
fn lang_name(code: &str) -> &'static str {
    match code.to_ascii_lowercase().as_str() {
        "zh" => "Simplified Chinese",
        "zh-tw" | "tw" => "Traditional Chinese",
        "en" => "English",
        "ja" => "Japanese",
        "ko" => "Korean",
        "de" => "German",
        "fr" => "French",
        "es" => "Spanish",
        "pt" => "Portuguese",
        "ru" => "Russian",
        "it" => "Italian",
        "ar" => "Arabic",
        "th" => "Thai",
        "vi" => "Vietnamese",
        "nl" => "Dutch",
        "pl" => "Polish",
        "tr" => "Turkish",
        "id" => "Indonesian",
        _ => "English",
    }
}

/// DeepL 的语言代码：目标要大写（中文还得区分简繁），`auto` 表示不传源语言
fn deepl_lang(code: &str) -> String {
    match code.to_ascii_lowercase().as_str() {
        "zh" => "ZH-HANS".into(),
        "zh-tw" | "tw" => "ZH-HANT".into(),
        "en" => "EN-US".into(),
        "pt" => "PT-BR".into(),
        other => other.to_ascii_uppercase(),
    }
}

/// Google / MyMemory 使用 BCP-47 风格（zh-CN / zh-TW）
fn bcp47(code: &str) -> String {
    match code.to_ascii_lowercase().as_str() {
        "zh" => "zh-CN".into(),
        "tw" | "zh-tw" => "zh-TW".into(),
        other => other.to_string(),
    }
}

/// OpenAI 兼容端点的最终 URL
fn openai_url(endpoint: Option<&str>) -> Result<String, String> {
    let raw = endpoint.map(str::trim).filter(|s| !s.is_empty());
    let raw = raw.unwrap_or(DEFAULT_OPENAI_BASE).trim_end_matches('/');

    if !(raw.starts_with("http://") || raw.starts_with("https://")) {
        return Err("OpenAI Base URL 必须以 http:// 或 https:// 开头".into());
    }
    if raw.ends_with("/chat/completions") {
        Ok(raw.to_string())
    } else {
        Ok(format!("{raw}/chat/completions"))
    }
}

/// DeepL 端点：`pro` / `free` 是快捷写法，也接受自定义地址
fn deepl_url(endpoint: Option<&str>) -> Result<String, String> {
    let raw = endpoint.map(str::trim).filter(|s| !s.is_empty());
    let host = match raw {
        None | Some("free") => DEEPL_FREE_HOST.to_string(),
        Some("pro") => DEEPL_PRO_HOST.to_string(),
        Some(other) => {
            if !(other.starts_with("http://") || other.starts_with("https://")) {
                return Err("DeepL 地址必须以 http:// 或 https:// 开头".into());
            }
            other.trim_end_matches('/').to_string()
        }
    };
    Ok(format!("{host}/v2/translate"))
}

fn read_secret(name: &str, hint: &str) -> Result<String, String> {
    match secrets::get(name) {
        Ok(Some(v)) if !v.trim().is_empty() => Ok(v.trim().to_string()),
        Ok(_) => Err(format!("未配置 {hint}。请在翻译插件的「设置」里填入")),
        Err(e) => Err(e),
    }
}

// ─── OpenAI 兼容 ───

async fn via_openai(
    client: &reqwest::Client,
    text: &str,
    from: &str,
    to: &str,
    endpoint: Option<&str>,
    model: Option<&str>,
) -> Result<String, String> {
    let key = read_secret(secrets::NAME_TRANSLATE_OPENAI, "OpenAI 兼容 API Key")?;
    let url = openai_url(endpoint)?;
    let model = model
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_OPENAI_MODEL);

    let mut system = format!(
        "You are a precise translation engine. Translate the user's text into {}.",
        lang_name(to)
    );
    if from != "auto" && !from.is_empty() {
        system.push_str(&format!(" The source language is {}.", lang_name(from)));
    }
    system.push_str(
        " Output ONLY the translation: no quotes, no explanations, no pinyin/romaji, \
         no markdown fences. Preserve the original line breaks and markdown structure.",
    );

    let body = serde_json::json!({
        "model": model,
        "temperature": 0,
        "stream": false,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": text }
        ]
    });

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {key}"))
        .header("Content-Type", "application/json")
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
            truncate_for_error(&raw)
        ));
    }

    let v: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("JSON 解析失败: {e}"))?;

    let content = v
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    match content {
        Some(t) => Ok(strip_wrapping(&t)),
        None => {
            // 把服务端给的错误信息透出来，否则只剩一个空结果让人无从下手
            let msg = v
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(|m| m.as_str())
                .unwrap_or("响应里没有 choices[0].message.content");
            Err(msg.to_string())
        }
    }
}

/// 模型偶尔会把译文包在引号或代码块里，这里只剥最外层
fn strip_wrapping(s: &str) -> String {
    let t = s.trim();
    let t = t
        .strip_prefix("```")
        .map(|rest| rest.split_once('\n').map(|(_, body)| body).unwrap_or(rest))
        .and_then(|rest| rest.strip_suffix("```").or(Some(rest)))
        .unwrap_or(t)
        .trim();

    let pairs = [('"', '"'), ('“', '”'), ('「', '」')];
    for (open, close) in pairs {
        if t.starts_with(open) && t.ends_with(close) && t.chars().count() > 2 {
            let inner: String = t.chars().skip(1).take(t.chars().count() - 2).collect();
            return inner.trim().to_string();
        }
    }
    t.to_string()
}

// ─── DeepL ───

async fn via_deepl(
    client: &reqwest::Client,
    text: &str,
    from: &str,
    to: &str,
    endpoint: Option<&str>,
) -> Result<String, String> {
    let key = read_secret(secrets::NAME_TRANSLATE_DEEPL, "DeepL API Key")?;
    let url = deepl_url(endpoint)?;

    let mut form: Vec<(&str, String)> =
        vec![("text", text.to_string()), ("target_lang", deepl_lang(to))];
    if from != "auto" && !from.is_empty() {
        form.push(("source_lang", deepl_lang(from)));
    }

    let resp = client
        .post(&url)
        .header("Authorization", format!("DeepL-Auth-Key {key}"))
        .form(&form)
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
            truncate_for_error(&raw)
        ));
    }

    let v: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("JSON 解析失败: {e}"))?;

    v.get("translations")
        .and_then(|t| t.get(0))
        .and_then(|t| t.get("text"))
        .and_then(|t| t.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("响应无法解析: {}", truncate_for_error(&raw)))
}

// ─── Google（免 Key） ───

/// Google gtx 返回 `[[["译文","原文",null,null,10],["续行","..."]],null,"en",...]`
fn join_google_segments(v: &serde_json::Value) -> String {
    v.get(0)
        .and_then(|segments| segments.as_array())
        .map(|segments| {
            segments
                .iter()
                .filter_map(|s| s.get(0).and_then(|t| t.as_str()))
                .collect::<String>()
        })
        .unwrap_or_default()
}

async fn via_google(
    client: &reqwest::Client,
    text: &str,
    from: &str,
    to: &str,
) -> Result<String, String> {
    let resp = client
        .get(GOOGLE_URL)
        .query(&[
            ("client", "gtx".to_string()),
            (
                "sl",
                if from == "auto" {
                    "auto".into()
                } else {
                    bcp47(from)
                },
            ),
            ("tl", bcp47(to)),
            ("dt", "t".to_string()),
            ("q", text.to_string()),
        ])
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
            truncate_for_error(&raw)
        ));
    }

    let v: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("JSON 解析失败: {e}"))?;

    let out = join_google_segments(&v);
    if out.trim().is_empty() {
        return Err("Google 返回空译文（可能是网络受限）".into());
    }
    Ok(out)
}

// ─── MyMemory（免 Key，兜底） ───

async fn via_mymemory(
    client: &reqwest::Client,
    text: &str,
    from: &str,
    to: &str,
) -> Result<String, String> {
    // 免费端点单次上限 500 字节，超了必然 400
    if text.len() > 500 {
        return Err("MyMemory 单次仅支持 500 字节，文本过长".into());
    }

    let src = if from == "auto" {
        "auto".to_string()
    } else {
        bcp47(from)
    };

    let resp = client
        .get(MYMEMORY_URL)
        .query(&[
            ("q", text.to_string()),
            ("langpair", format!("{src}|{}", bcp47(to))),
        ])
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
            truncate_for_error(&raw)
        ));
    }

    let v: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("JSON 解析失败: {e}"))?;

    let text = v
        .get("responseData")
        .and_then(|d| d.get("translatedText"))
        .and_then(|t| t.as_str())
        .unwrap_or("");

    // 配额用尽时它也返回 200，正文却是提示语
    let lower = text.to_ascii_lowercase();
    if text.trim().is_empty() || lower.contains("quota") || lower.contains("my memory") {
        let detail = v
            .get("responseDetails")
            .and_then(|d| d.as_str())
            .unwrap_or(text);
        return Err(format!("MyMemory 不可用: {}", truncate_for_error(detail)));
    }

    Ok(text.to_string())
}

// ─── Command ───

/// 多引擎翻译。
///
/// `provider` 取 `openai` / `deepl` / `google` / `mymemory`。
/// `endpoint` / `model` 只对 openai、deepl 生效（前者是 Base URL / DeepL 主机，
/// 后者是模型名）。**Key 一律从凭据管理器读，不接受前端传入。**
#[tauri::command]
pub async fn translate_web(
    app: AppHandle,
    provider: String,
    text: String,
    from: String,
    to: String,
    endpoint: Option<String>,
    model: Option<String>,
) -> Result<WebTranslateOut, String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("翻译文本不能为空".into());
    }
    if text.chars().count() > MAX_CHARS {
        return Err(format!("单次翻译不能超过 {MAX_CHARS} 字符"));
    }
    if to.trim().is_empty() {
        return Err("目标语言不能为空".into());
    }

    let provider = provider.trim().to_ascii_lowercase();
    let from = if from.trim().is_empty() {
        "auto".to_string()
    } else {
        from.trim().to_ascii_lowercase()
    };
    let to = to.trim().to_ascii_lowercase();

    let client = build_client()?;

    crate::core::app_log::emit(
        &app,
        "info",
        &format!(
            "[translate] engine={provider} {from}→{to} len={}",
            text.chars().count()
        ),
    );

    let translated = match provider.as_str() {
        "openai" => {
            via_openai(
                &client,
                &text,
                &from,
                &to,
                endpoint.as_deref(),
                model.as_deref(),
            )
            .await
        }
        "deepl" => via_deepl(&client, &text, &from, &to, endpoint.as_deref()).await,
        "google" => via_google(&client, &text, &from, &to).await,
        "mymemory" => via_mymemory(&client, &text, &from, &to).await,
        other => Err(format!("未知的翻译引擎: {other}")),
    };

    let translated = match translated {
        Ok(t) => t,
        Err(e) => {
            crate::core::app_log::emit(
                &app,
                "warn",
                &format!("[translate] engine={provider} 失败: {e}"),
            );
            return Err(e);
        }
    };

    crate::core::app_log::emit(
        &app,
        "info",
        &format!(
            "[translate] engine={provider} 成功 out_len={}",
            translated.chars().count()
        ),
    );

    Ok(WebTranslateOut {
        text: translated,
        from,
        to,
        engine: provider,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openai_url_accepts_base_and_full() {
        assert_eq!(
            openai_url(None).unwrap(),
            "https://api.openai.com/v1/chat/completions"
        );
        assert_eq!(
            openai_url(Some("https://api.example.com/v1/")).unwrap(),
            "https://api.example.com/v1/chat/completions"
        );
        // 已经写到 /chat/completions 的不要再拼一遍
        assert_eq!(
            openai_url(Some("https://api.example.com/v1/chat/completions")).unwrap(),
            "https://api.example.com/v1/chat/completions"
        );
        assert!(openai_url(Some("api.example.com")).is_err());
    }

    #[test]
    fn deepl_url_shortcuts() {
        assert_eq!(
            deepl_url(None).unwrap(),
            "https://api-free.deepl.com/v2/translate"
        );
        assert_eq!(
            deepl_url(Some("pro")).unwrap(),
            "https://api.deepl.com/v2/translate"
        );
        assert!(deepl_url(Some("nope")).is_err());
    }

    #[test]
    fn deepl_lang_maps_chinese() {
        assert_eq!(deepl_lang("zh"), "ZH-HANS");
        assert_eq!(deepl_lang("tw"), "ZH-HANT");
        assert_eq!(deepl_lang("en"), "EN-US");
        assert_eq!(deepl_lang("ja"), "JA");
    }

    #[test]
    fn bcp47_maps_chinese() {
        assert_eq!(bcp47("zh"), "zh-CN");
        assert_eq!(bcp47("zh-tw"), "zh-TW");
        assert_eq!(bcp47("en"), "en");
    }

    #[test]
    fn google_segments_are_concatenated() {
        let v: serde_json::Value = serde_json::from_str(
            r#"[[["你好","hello",null,null,10],["世界"," world",null,null,10]],null,"en"]"#,
        )
        .unwrap();
        assert_eq!(join_google_segments(&v), "你好世界");
        assert_eq!(join_google_segments(&serde_json::json!(null)), "");
    }

    #[test]
    fn strip_wrapping_only_touches_outer_layer() {
        assert_eq!(strip_wrapping("\"你好\""), "你好");
        assert_eq!(strip_wrapping("「こんにちは」"), "こんにちは");
        assert_eq!(strip_wrapping("```\n你好\n```"), "你好");
        // 引号里只有一个字符时不动（避免把正常符号当包裹）
        assert_eq!(strip_wrapping("\"\""), "\"\"");
        assert_eq!(strip_wrapping("plain"), "plain");
    }

    #[test]
    fn lang_name_covers_known_and_defaults() {
        assert_eq!(lang_name("zh"), "Simplified Chinese");
        assert_eq!(lang_name("JA"), "Japanese");
        assert_eq!(lang_name("xx"), "English");
    }
}
