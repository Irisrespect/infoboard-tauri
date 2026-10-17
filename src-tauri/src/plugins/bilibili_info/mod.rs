// ─── B站视频信息补充 ───
//
// 复刻自 Electron 版 electron/bilibiliInfo.ts（已验证生产可用）
//
// 数据流：
//   1. 清洗标题
//   2. 调 search/type 搜索（带 Cookie/Referer）
//   3. 标题匹配：去 HTML 后精确/包含匹配，否则第一个结果
//   4. 用 BV 号调 view API 取封面/UP主

use std::time::Duration;
use tauri::AppHandle;
use serde::{Deserialize, Serialize};

// ─── 常量 ───

const SEARCH_API: &str = "https://api.bilibili.com/x/web-interface/search/type";
const VIEW_API: &str = "https://api.bilibili.com/x/web-interface/view";
const TIMEOUT_SECS: u64 = 10;

// ─── 返回类型 ───

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BilibiliVideoInfo {
    pub cover: String,
    pub owner_name: String,
    pub owner_avatar: String,
    pub bvid: String,
    pub play_count: i64,
    pub danmaku_count: i64,
}

// ─── 搜索响应 ───

#[derive(Debug, Deserialize)]
struct SearchResponse {
    code: i64,
    data: Option<SearchData>,
}

#[derive(Debug, Deserialize)]
struct SearchData {
    result: Option<Vec<SearchResultItem>>,
}

#[derive(Debug, Deserialize)]
struct SearchResultItem {
    bvid: Option<String>,
    title: Option<String>,
}

// ─── 详情响应 ───

#[derive(Debug, Deserialize)]
struct ViewResponse {
    code: i64,
    data: Option<ViewData>,
}

#[derive(Debug, Deserialize)]
struct ViewData {
    pic: Option<String>,
    owner: Option<ViewOwner>,
    stat: Option<ViewStat>,
}

#[derive(Debug, Deserialize)]
struct ViewOwner {
    name: Option<String>,
    face: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ViewStat {
    view: Option<i64>,
    danmaku: Option<i64>,
}

// ─── 标题清洗 ───

/// 清洗标题（复刻 Electron cleanTitle）—— 保留空格，供搜索用
// 预编译正则，避免热路径每次 Regex::new
static RE_TITLE_PREFIX: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
    regex::Regex::new(r"(?i)^\d+[\s\-_.]*[歌曲音乐]*[\s\-_.]*").expect("RE_TITLE_PREFIX")
});
static RE_TITLE_SUFFIX: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
    regex::Regex::new(r"(?i)\s*[-—]\s*(哔哩哔哩|bilibili)$").expect("RE_TITLE_SUFFIX")
});
static RE_HTML_TAG: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
    regex::Regex::new(r"<[^>]+>").expect("RE_HTML_TAG")
});

fn clean_title(raw: &str) -> String {
    let mut t = raw.to_string();
    t = RE_TITLE_PREFIX.replace(&t, "").to_string();
    t = RE_TITLE_SUFFIX.replace(&t, "").to_string();
    t.trim().to_string()
}

/// 归一化用于比较（去 HTML、去空白、小写）—— 复刻 Electron normalized()
fn normalize_for_match(s: &str) -> String {
    let t = RE_HTML_TAG.replace_all(s, "");
    t.chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .to_lowercase()
}

/// 条目可用：必须有非空 bvid（后续要用它取详情）
fn has_bvid(item: &SearchResultItem) -> bool {
    item.bvid.as_deref().is_some_and(|b| !b.is_empty())
}

/// 从搜索结果中找最佳匹配（复刻 Electron findBestMatch）
///
/// - 只考虑带 bvid 的条目，否则选中后取详情必失败
/// - 空标题不参与包含匹配：`x.contains("")` 恒为真，会让坏条目抢走匹配
fn find_best_match<'a>(
    results: &'a [SearchResultItem],
    target_title: &str,
) -> Option<&'a SearchResultItem> {
    let usable: Vec<&SearchResultItem> = results.iter().filter(|r| has_bvid(r)).collect();
    if usable.is_empty() {
        return None;
    }

    let target = normalize_for_match(target_title);

    if !target.is_empty() {
        for r in &usable {
            let r_title = normalize_for_match(r.title.as_deref().unwrap_or(""));
            if r_title.is_empty() {
                continue;
            }
            if r_title == target || r_title.contains(&target) || target.contains(&r_title) {
                return Some(r);
            }
        }
    }

    // 无精确匹配，返回第一个可用条目
    Some(usable[0])
}

// ─── HTTP ───

fn build_client() -> Result<reqwest::Client, String> {
    // 与 Electron 版 headers 一致
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::REFERER,
        "https://search.bilibili.com"
            .parse()
            .map_err(|e| format!("{e}"))?,
    );
    headers.insert(
        reqwest::header::ORIGIN,
        "https://search.bilibili.com"
            .parse()
            .map_err(|e| format!("{e}"))?,
    );
    headers.insert(
        reqwest::header::COOKIE,
        "buvid3=bili_enrich".parse().map_err(|e| format!("{e}"))?,
    );

    reqwest::Client::builder()
        .timeout(Duration::from_secs(TIMEOUT_SECS))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
        .default_headers(headers)
        .build()
        .map_err(|e| format!("HTTP 客户端创建失败: {e}"))
}

async fn search_video(
    client: &reqwest::Client,
    keyword: &str,
) -> Result<Vec<SearchResultItem>, String> {
    let resp = client
        .get(SEARCH_API)
        .query(&[
            ("search_type", "video"),
            ("keyword", keyword),
            ("page", "1"),
            ("page_size", "3"),
        ])
        .send()
        .await
        .map_err(|e| format!("B站搜索请求失败: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("B站搜索 HTTP {}", resp.status().as_u16()));
    }

    let text = resp
        .text()
        .await
        .map_err(|e| format!("B站搜索读 body 失败: {e}"))?;

    let body: SearchResponse = serde_json::from_str(&text).map_err(|e| {
        format!(
            "B站搜索响应解析失败: {e}; body={}",
            crate::core::text::truncate_bytes(&text, 200)
        )
    })?;

    if body.code != 0 {
        return Err(format!("B站搜索 API 错误 code={}", body.code));
    }

    Ok(body.data.and_then(|d| d.result).unwrap_or_default())
}

async fn get_view(client: &reqwest::Client, bvid: &str) -> Result<BilibiliVideoInfo, String> {
    let resp = client
        .get(VIEW_API)
        .query(&[("bvid", bvid)])
        .send()
        .await
        .map_err(|e| format!("B站详情请求失败: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("B站详情 HTTP {}", resp.status().as_u16()));
    }

    let body: ViewResponse = resp
        .json()
        .await
        .map_err(|e| format!("B站详情响应解析失败: {e}"))?;

    if body.code != 0 {
        return Err(format!("B站详情 API 错误 code={}", body.code));
    }

    let data = body.data.ok_or_else(|| "B站详情无 data".to_string())?;
    let owner = data.owner.unwrap_or(ViewOwner {
        name: None,
        face: None,
    });
    let stat = data.stat.unwrap_or(ViewStat {
        view: None,
        danmaku: None,
    });

    // B站 API 可能返回 http:// 封面/头像 → 升级为 https 避免 WebView CSP 拦截
    let cover = data.pic.unwrap_or_default().replace("http://", "https://");
    let owner_avatar = owner.face.unwrap_or_default().replace("http://", "https://");
    Ok(BilibiliVideoInfo {
        cover,
        owner_name: owner.name.unwrap_or_default(),
        owner_avatar,
        bvid: bvid.to_string(),
        play_count: stat.view.unwrap_or(0),
        danmaku_count: stat.danmaku.unwrap_or(0),
    })
}

// ─── Tauri Command ───

/// 通过 B站 API 补充视频信息（封面 + UP主）
///
/// 返回 `Result<Option<_>, String>`：`Ok(None)` 表示"查了但没有匹配"，
/// `Err` 表示"请求/解析失败"。原先一律返回 `Option`，前端把
/// "B站接口不通 / 被风控 / 超时"与"确实没有这个视频"都当成"没有结果"，
/// 用户看不到任何异常（只在日志里）。
#[tauri::command]
pub async fn bilibili_enrich_media(
    app: AppHandle,
    title: String,
) -> Result<Option<BilibiliVideoInfo>, String> {
    let clean = clean_title(&title);
    if clean.is_empty() {
        return Ok(None);
    }

    crate::core::app_log::emit(&app, "info", &format!("[bilibili] 搜索: {clean}"));

    let client = build_client().map_err(|e| {
        let msg = format!("B站客户端初始化失败: {e}");
        crate::core::app_log::emit(&app, "error", &format!("[bilibili] {msg}"));
        msg
    })?;

    let results = search_video(&client, &clean).await.map_err(|e| {
        crate::core::app_log::emit(&app, "error", &format!("[bilibili] 搜索失败: {e}"));
        e
    })?;

    if results.is_empty() {
        crate::core::app_log::emit(&app, "warn", &format!("[bilibili] 无搜索结果: {clean}"));
        return Ok(None);
    }

    // 有结果但没有可用条目（缺 bvid / 标题全空）→ 同样是"没匹配上"，不是错误
    let Some(best) = find_best_match(&results, &clean) else {
        crate::core::app_log::emit(&app, "warn", &format!("[bilibili] 结果中无可用条目: {clean}"));
        return Ok(None);
    };
    let Some(bvid) = best.bvid.as_deref().filter(|s| !s.is_empty()) else {
        return Ok(None);
    };

    crate::core::app_log::emit(
        &app,
        "info",
        &format!("[bilibili] 匹配: bvid={bvid} title={:?}", best.title),
    );

    match get_view(&client, bvid).await {
        Ok(info) => {
            crate::core::app_log::emit(
                &app,
                "info",
                &format!(
                    "[bilibili] 详情: owner={} cover={}",
                    info.owner_name, info.cover
                ),
            );
            Ok(Some(info))
        }
        Err(e) => {
            crate::core::app_log::emit(&app, "error", &format!("[bilibili] 详情失败: {e}"));
            Err(e)
        }
    }
}

// ─── 单元测试 ───

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_clean_title_remove_suffix() {
        assert_eq!(
            clean_title("赛博朋克2077 全剧情 —哔哩哔哩"),
            "赛博朋克2077 全剧情"
        );
    }

    #[test]
    fn test_clean_title_remove_prefix() {
        assert_eq!(clean_title("01 周杰伦-晴天"), "周杰伦-晴天");
    }

    #[test]
    fn test_normalize_for_match_strips_html() {
        let n = normalize_for_match("<em class=\"keyword\">赛博</em>朋克");
        assert_eq!(n, "赛博朋克");
    }

    #[test]
    fn test_find_best_match_exact() {
        let results = vec![
            SearchResultItem {
                bvid: Some("BV1xx".into()),
                title: Some("<em>测试</em>视频A".into()),
            },
            SearchResultItem {
                bvid: Some("BV2yy".into()),
                title: Some("完全无关".into()),
            },
        ];
        let best = find_best_match(&results, "测试视频A").unwrap();
        assert_eq!(best.bvid.as_deref(), Some("BV1xx"));
    }

    /// 回归：空标题条目（target.contains("") 恒真）不能抢走匹配
    #[test]
    fn test_find_best_match_skips_empty_title() {
        let results = vec![
            SearchResultItem { bvid: None, title: Some("".into()) },
            SearchResultItem { bvid: Some("BV1ok".into()), title: Some("测试视频A".into()) },
        ];
        let best = find_best_match(&results, "测试视频A").unwrap();
        assert_eq!(best.bvid.as_deref(), Some("BV1ok"));
    }

    /// 回归：纯 HTML/空白标题归一化后为空，同样不能参与包含匹配
    #[test]
    fn test_find_best_match_skips_blank_after_normalize() {
        let results = vec![
            SearchResultItem { bvid: Some("BVbad".into()), title: Some("<em></em>  ".into()) },
            SearchResultItem { bvid: Some("BV1ok".into()), title: Some("测试视频A".into()) },
        ];
        let best = find_best_match(&results, "测试视频A").unwrap();
        assert_eq!(best.bvid.as_deref(), Some("BV1ok"));
    }

    /// 回归：没有 bvid 的条目即使标题匹配也不可用（后续取详情必失败）
    #[test]
    fn test_find_best_match_skips_missing_bvid() {
        let results = vec![
            SearchResultItem { bvid: None, title: Some("测试视频A".into()) },
            SearchResultItem { bvid: Some("BV1ok".into()), title: Some("测试视频A 高清".into()) },
        ];
        let best = find_best_match(&results, "测试视频A").unwrap();
        assert_eq!(best.bvid.as_deref(), Some("BV1ok"));
    }

    /// 回归：目标标题为空时不应"匹配"任何条目，退回首个可用条目
    #[test]
    fn test_find_best_match_empty_target_falls_back_to_first_usable() {
        let results = vec![
            SearchResultItem { bvid: None, title: Some("甲".into()) },
            SearchResultItem { bvid: Some("BV1ok".into()), title: Some("乙".into()) },
        ];
        let best = find_best_match(&results, "").unwrap();
        assert_eq!(best.bvid.as_deref(), Some("BV1ok"));
    }

    #[test]
    fn test_find_best_match_fallback_first() {
        let results = vec![
            SearchResultItem {
                bvid: Some("BV1aa".into()),
                title: Some("无关1".into()),
            },
            SearchResultItem {
                bvid: Some("BV2bb".into()),
                title: Some("无关2".into()),
            },
        ];
        let best = find_best_match(&results, "完全不同的标题xyz").unwrap();
        assert_eq!(best.bvid.as_deref(), Some("BV1aa"));
    }
}