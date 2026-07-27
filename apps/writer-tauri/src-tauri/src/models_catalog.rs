// The authoritative Claude model catalog, read straight from `GET /v1/models`.
//
// Why this exists: everything else the app can ask lags a model release. The
// Agent SDK's supportedModels() handshake described Opus as 4.8 for days after
// Opus 5 shipped, and the CLI's "latest" alias (`opus`) resolved to 4.8 too — so
// a new model was invisible to the app until someone hand-edited the built-in
// list. This endpoint had Opus 5 on release day, with the display name, context
// window and effort tiers the app otherwise hardcodes.
//
// The catalog is ADDITIVE on the frontend: it's merged with the built-in list
// rather than replacing it, so a fetch failure (offline, no token, API change)
// can only fail to add models — never remove one the user was already using.
// That's why an absent token returns an empty list instead of an error.

use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;

use crate::oauth;

const MODELS_URL: &str = "https://api.anthropic.com/v1/models";
const API_VERSION: &str = "2023-06-01";
// The subscription OAuth token is only accepted on `Authorization: Bearer` when
// this beta is declared; with `x-api-key` (or without the header) /v1/messages
// rejects it. Sent on every request so the call keeps working if we ever point
// it at a different endpoint.
const OAUTH_BETA: &str = "oauth-2025-04-20";

// reqwest has NO default timeout — an unreachable host would hang the command
// forever. Same reason oauth.rs builds its refresh client with an explicit one.
const HTTP_TIMEOUT: Duration = Duration::from_secs(10);
// The endpoint pages; today it returns 11 models in one page. Bounded so a
// server that always reports `has_more` can't spin here.
const MAX_PAGES: usize = 10;
const PAGE_SIZE: u32 = 100;

/// One model, flattened to just what the app renders or sends. `capabilities`
/// is deliberately NOT passed through whole: the frontend only needs the effort
/// tiers, and narrowing here keeps the IPC payload from growing every time the
/// API adds a capability flag.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelEntry {
    pub id: String,
    pub display_name: String,
    /// ISO-8601 release timestamp. The frontend sorts on it so a newly shipped
    /// model surfaces at the top without anyone curating an order.
    pub created_at: Option<String>,
    /// Input-token window. Replaces the hand-maintained CONTEXT_LIMITS table,
    /// whose unknown-id fallback (200k) under-reports every 1M-window model.
    pub max_input_tokens: Option<u64>,
    pub max_tokens: Option<u64>,
    /// Supported effort tiers, ascending, e.g. ["low","medium","high","xhigh"].
    /// Empty when the model exposes no effort control.
    pub efforts: Vec<String>,
}

/// Effort tiers in ascending order — the order the UI draws them in.
const EFFORT_LEVELS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

fn efforts_from(capabilities: Option<&Value>) -> Vec<String> {
    let Some(effort) = capabilities.and_then(|c| c.get("effort")) else {
        return Vec::new();
    };
    if effort.get("supported").and_then(Value::as_bool) != Some(true) {
        return Vec::new();
    }
    EFFORT_LEVELS
        .iter()
        .filter(|level| {
            effort
                .get(**level)
                .and_then(|v| v.get("supported"))
                .and_then(Value::as_bool)
                == Some(true)
        })
        .map(|level| (*level).to_string())
        .collect()
}

fn parse_entry(item: &Value) -> Option<ModelEntry> {
    let id = item.get("id").and_then(Value::as_str)?.to_string();
    // Ignore anything that isn't a Claude model id — the app sends this string
    // straight to the Agent SDK, so a stray entry would become a broken picker
    // row rather than a harmless extra.
    if !id.starts_with("claude-") {
        return None;
    }
    let display_name = item
        .get("display_name")
        .and_then(Value::as_str)
        .unwrap_or(&id)
        .to_string();
    Some(ModelEntry {
        id,
        display_name,
        created_at: item
            .get("created_at")
            .and_then(Value::as_str)
            .map(str::to_string),
        max_input_tokens: item.get("max_input_tokens").and_then(Value::as_u64),
        max_tokens: item.get("max_tokens").and_then(Value::as_u64),
        efforts: efforts_from(item.get("capabilities")),
    })
}

/// Fetch the account's model catalog.
///
/// Returns an EMPTY list (not an error) when there's no usable token — that's
/// the normal pre-login state, and the caller treats "no catalog" and "empty
/// catalog" the same way: fall back to the built-in list. A transport or HTTP
/// failure IS an error, so it can be logged rather than silently masking a
/// misconfiguration.
#[tauri::command]
pub async fn anthropic_list_models(app: AppHandle) -> Result<Vec<ModelEntry>, String> {
    // get_claude_token refreshes an expiring token, serializes concurrent
    // callers, and returns Ok(None) (never Err) when the stored token is
    // unusable — so there's no expiry handling to repeat here.
    let Some(token) = oauth::get_claude_token(app).await? else {
        return Ok(Vec::new());
    };

    let client = reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|e| format!("models client build failed: {e}"))?;

    let mut out: Vec<ModelEntry> = Vec::new();
    let mut after_id: Option<String> = None;

    for _ in 0..MAX_PAGES {
        let mut req = client
            .get(MODELS_URL)
            .query(&[("limit", PAGE_SIZE.to_string())])
            .header("Authorization", format!("Bearer {token}"))
            .header("anthropic-version", API_VERSION)
            .header("anthropic-beta", OAUTH_BETA);
        if let Some(cursor) = &after_id {
            req = req.query(&[("after_id", cursor)]);
        }

        let resp = req
            .send()
            .await
            .map_err(|e| format!("GET /v1/models failed: {e}"))?;

        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("GET /v1/models {status}: {text}"));
        }

        let body: Value = resp
            .json()
            .await
            .map_err(|e| format!("GET /v1/models parse failed: {e}"))?;

        let items = body.get("data").and_then(Value::as_array).cloned().unwrap_or_default();
        out.extend(items.iter().filter_map(parse_entry));

        let has_more = body.get("has_more").and_then(Value::as_bool) == Some(true);
        let last_id = body.get("last_id").and_then(Value::as_str).map(str::to_string);
        match (has_more, last_id) {
            (true, Some(cursor)) => after_id = Some(cursor),
            // `has_more` without a cursor would loop forever on the same page.
            _ => break,
        }
    }

    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_a_live_shaped_entry() {
        // Trimmed from a real GET /v1/models response.
        let item = json!({
            "type": "model",
            "id": "claude-opus-5",
            "display_name": "Claude Opus 5",
            "created_at": "2026-07-24T00:00:00Z",
            "max_input_tokens": 1_000_000,
            "max_tokens": 128_000,
            "capabilities": {
                "effort": {
                    "supported": true,
                    "low": { "supported": true },
                    "medium": { "supported": true },
                    "high": { "supported": true },
                    "xhigh": { "supported": true },
                    "max": { "supported": true }
                }
            }
        });
        let entry = parse_entry(&item).expect("should parse");
        assert_eq!(entry.id, "claude-opus-5");
        assert_eq!(entry.display_name, "Claude Opus 5");
        assert_eq!(entry.max_input_tokens, Some(1_000_000));
        assert_eq!(entry.efforts, ["low", "medium", "high", "xhigh", "max"]);
    }

    #[test]
    fn keeps_effort_levels_in_ascending_order_and_drops_unsupported() {
        let item = json!({
            "id": "claude-haiku-4-5",
            "capabilities": {
                // Deliberately out of order + one unsupported tier.
                "effort": {
                    "supported": true,
                    "high": { "supported": true },
                    "low": { "supported": true },
                    "xhigh": { "supported": false },
                    "medium": { "supported": true }
                }
            }
        });
        let entry = parse_entry(&item).unwrap();
        assert_eq!(entry.efforts, ["low", "medium", "high"]);
    }

    #[test]
    fn model_without_effort_support_reports_none() {
        let item = json!({ "id": "claude-x", "capabilities": { "effort": { "supported": false } } });
        assert!(parse_entry(&item).unwrap().efforts.is_empty());

        let bare = json!({ "id": "claude-x" });
        assert!(parse_entry(&bare).unwrap().efforts.is_empty());
    }

    #[test]
    fn falls_back_to_the_id_when_display_name_is_missing() {
        let item = json!({ "id": "claude-future-9" });
        assert_eq!(parse_entry(&item).unwrap().display_name, "claude-future-9");
    }

    #[test]
    fn skips_non_claude_ids() {
        assert!(parse_entry(&json!({ "id": "gpt-4" })).is_none());
        assert!(parse_entry(&json!({ "display_name": "no id" })).is_none());
    }
}
