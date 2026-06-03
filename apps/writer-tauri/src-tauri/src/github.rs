// GitHub OAuth via Device Flow.
//
// Device Flow suits a desktop app with no loopback server (mirrors the
// shape of the Claude paste-back flow next door in oauth.rs):
//  1) frontend invokes `start_github_device_flow` → we ask GitHub for a
//     device+user code, stash the device code, return the user code +
//     verification URL for the UI to display.
//  2) user opens github.com/login/device, types the user code, authorizes.
//  3) frontend polls `poll_github_device_flow` every `interval` seconds →
//     we exchange the device code for a token; while the user hasn't
//     finished we return Pending. On success we fetch the login, persist
//     the token via secure_storage, and return Connected.
//
// GitHub OAuth-app user tokens don't expire by default, so there's no
// refresh dance — just store the access token.

use crate::events::{db, Entry};
use crate::secure_storage;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

// Public client id from the registered GitHub OAuth App (Device Flow
// enabled). Safe to embed — it's not a secret. Device Flow uses no
// client secret.
const CLIENT_ID: &str = "Ov23liRSodZShOp6eiRC";
// read:user is enough to read the login + public activity for the first
// slice. Widening to `repo` (private activity) is a later re-auth.
const SCOPE: &str = "read:user";
const DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
const API_USER_URL: &str = "https://api.github.com/user";
const USER_AGENT: &str = "writer-tauri";
const STORAGE_NAME: &str = "github-oauth";

/// In-flight device flow. Holds the device code between `start` and the
/// `poll` calls that follow.
#[derive(Default)]
pub struct PendingGitHubAuth(pub Mutex<Option<PendingDevice>>);

pub struct PendingDevice {
    pub device_code: String,
}

/// Token + login persisted to secure storage.
#[derive(Serialize, Deserialize)]
struct StoredToken {
    access_token: String,
    login: String,
}

// ----- start -----

#[derive(Deserialize)]
struct DeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    interval: u64,
}

/// What the UI shows the user: the code to type and where to type it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCodeInfo {
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    pub interval: u64,
}

#[tauri::command]
pub async fn start_github_device_flow(app: AppHandle) -> Result<DeviceCodeInfo, String> {
    let resp = reqwest::Client::new()
        .post(DEVICE_CODE_URL)
        .header("Accept", "application/json")
        .form(&[("client_id", CLIENT_ID), ("scope", SCOPE)])
        .send()
        .await
        .map_err(|e| format!("device code request failed: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("device code {status}: {text}"));
    }

    let data: DeviceCodeResponse = resp
        .json()
        .await
        .map_err(|e| format!("device code parse failed: {e}"))?;

    {
        let pending = app.state::<PendingGitHubAuth>();
        let mut slot = pending.0.lock().map_err(|e| e.to_string())?;
        *slot = Some(PendingDevice {
            device_code: data.device_code,
        });
    }

    Ok(DeviceCodeInfo {
        user_code: data.user_code,
        verification_uri: data.verification_uri,
        expires_in: data.expires_in,
        interval: data.interval,
    })
}

// ----- poll -----

#[derive(Deserialize)]
struct TokenPollResponse {
    #[serde(default)]
    access_token: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

/// Outcome of one poll. `Pending` means keep polling at the interval;
/// the others are terminal.
#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum PollResult {
    Pending,
    Connected { login: String },
    Denied,
    Expired,
}

#[tauri::command]
pub async fn poll_github_device_flow(app: AppHandle) -> Result<PollResult, String> {
    let device_code = {
        let pending = app.state::<PendingGitHubAuth>();
        let slot = pending.0.lock().map_err(|e| e.to_string())?;
        match slot.as_ref() {
            Some(p) => p.device_code.clone(),
            None => return Err("no pending github device flow".to_string()),
        }
    };

    let resp = reqwest::Client::new()
        .post(TOKEN_URL)
        .header("Accept", "application/json")
        .form(&[
            ("client_id", CLIENT_ID),
            ("device_code", device_code.as_str()),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ])
        .send()
        .await
        .map_err(|e| format!("token poll failed: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("token poll {status}: {text}"));
    }

    // GitHub returns 200 with either an access_token or an `error` field
    // (authorization_pending / slow_down / expired_token / access_denied).
    let data: TokenPollResponse = resp
        .json()
        .await
        .map_err(|e| format!("token poll parse failed: {e}"))?;

    if let Some(token) = data.access_token {
        let login = fetch_login(&token).await?;
        let stored = StoredToken {
            access_token: token,
            login: login.clone(),
        };
        let json = serde_json::to_vec(&stored).map_err(|e| e.to_string())?;
        secure_storage::save(&app, STORAGE_NAME, &json)?;
        clear_pending(&app)?;
        return Ok(PollResult::Connected { login });
    }

    match data.error.as_deref() {
        // Still waiting on the user. slow_down is benign here because the
        // frontend already paces polls at `interval` seconds.
        Some("authorization_pending") | Some("slow_down") => Ok(PollResult::Pending),
        Some("expired_token") => {
            clear_pending(&app)?;
            Ok(PollResult::Expired)
        }
        Some("access_denied") => {
            clear_pending(&app)?;
            Ok(PollResult::Denied)
        }
        Some(other) => Err(format!("github device flow error: {other}")),
        None => Err("token poll returned neither token nor error".to_string()),
    }
}

async fn fetch_login(token: &str) -> Result<String, String> {
    #[derive(Deserialize)]
    struct GitHubUser {
        login: String,
    }

    let resp = reqwest::Client::new()
        .get(API_USER_URL)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", USER_AGENT)
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| format!("github /user failed: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("github /user {status}: {text}"));
    }

    let user: GitHubUser = resp
        .json()
        .await
        .map_err(|e| format!("github /user parse failed: {e}"))?;
    Ok(user.login)
}

// ----- status / disconnect -----

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubAccount {
    pub connected: bool,
    pub login: Option<String>,
}

fn load_token(app: &AppHandle) -> Result<Option<StoredToken>, String> {
    let bytes = match secure_storage::load(app, STORAGE_NAME)? {
        Some(b) => b,
        None => return Ok(None),
    };
    let token: StoredToken = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    Ok(Some(token))
}

#[tauri::command]
pub async fn get_github_account(app: AppHandle) -> Result<GitHubAccount, String> {
    let stored = load_token(&app)?;
    Ok(GitHubAccount {
        connected: stored.is_some(),
        login: stored.map(|s| s.login),
    })
}

/// Used by the connector slice to authorize API calls. Returns None when
/// not connected.
#[tauri::command]
pub async fn get_github_token(app: AppHandle) -> Result<Option<String>, String> {
    Ok(load_token(&app)?.map(|s| s.access_token))
}

#[tauri::command]
pub async fn disconnect_github(app: AppHandle) -> Result<(), String> {
    clear_pending(&app)?;
    secure_storage::delete(&app, STORAGE_NAME)
}

fn clear_pending(app: &AppHandle) -> Result<(), String> {
    let pending = app.state::<PendingGitHubAuth>();
    let mut slot = pending.0.lock().map_err(|e| e.to_string())?;
    *slot = None;
    Ok(())
}

// ----- connector: fetch activity into events.db -----

const SOURCE: &str = "github";

/// Pull recent GitHub activity into events.db. Frontend-scheduled (the
/// rust side doesn't know the active vault) and passes the ingest
/// timestamp so all rows in one sync share a batch time. Returns the
/// number of events upserted.
///
/// Failure modes are deliberately soft: not connected → Ok(0); GitHub
/// unreachable → Err (the frontend logs and retries next tick). Nothing
/// here touches the markdown vault.
#[tauri::command]
pub async fn github_sync(
    app: AppHandle,
    vault_path: String,
    ingested_at: String,
) -> Result<usize, String> {
    let Some(stored) = load_token(&app)? else {
        return Ok(0); // not connected — nothing to do
    };

    let client = reqwest::Client::new();

    // Commits are the core signal — fail the sync if they can't be fetched.
    let mut entries = fetch_commits(&client, &stored, &ingested_at).await?;
    // PRs are best-effort: a search hiccup shouldn't drop the commits.
    match fetch_prs(&client, &stored, &ingested_at).await {
        Ok(prs) => entries.extend(prs),
        Err(e) => eprintln!("[github] pr fetch failed: {e}"),
    }

    let watermark = entries.first().map(|e| e.id.clone());
    let count = entries.len();

    let mut conn = db::open(&vault_path)?;
    if !entries.is_empty() {
        db::upsert_events(&mut conn, &entries)?;
    }
    db::write_connector_state(
        &conn,
        SOURCE,
        &db::ConnectorState {
            watermark,
            etag: None,
            updated_at: Some(ingested_at),
        },
    )?;
    Ok(count)
}

/// Authenticated GET returning parsed JSON. Errors carry status + body so
/// failures are diagnosable from the frontend console.
async fn github_get(
    client: &reqwest::Client,
    url: &str,
    query: &[(&str, &str)],
    token: &str,
) -> Result<serde_json::Value, String> {
    let resp = client
        .get(url)
        .query(query)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", USER_AGENT)
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| format!("github request failed: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("github {status}: {text}"));
    }
    resp.json()
        .await
        .map_err(|e| format!("github parse failed: {e}"))
}

/// Recent commits authored by the user. The events API only carries push
/// head/before SHAs (no messages), so we use search/commits which returns
/// sha + message + author date + repo directly.
async fn fetch_commits(
    client: &reqwest::Client,
    stored: &StoredToken,
    ingested_at: &str,
) -> Result<Vec<Entry>, String> {
    let q = format!("author:{}", stored.login);
    let data = github_get(
        client,
        "https://api.github.com/search/commits",
        &[
            ("q", q.as_str()),
            ("sort", "committer-date"),
            ("order", "desc"),
            ("per_page", "50"),
        ],
        &stored.access_token,
    )
    .await?;
    Ok(map_commits(&data, ingested_at))
}

fn map_commits(data: &serde_json::Value, ingested_at: &str) -> Vec<Entry> {
    let mut out = Vec::new();
    let Some(items) = data.get("items").and_then(|i| i.as_array()) else {
        return out;
    };
    for it in items {
        let sha = it.get("sha").and_then(|s| s.as_str()).unwrap_or("");
        let commit = it.get("commit");
        let message = commit
            .and_then(|c| c.get("message"))
            .and_then(|m| m.as_str())
            .unwrap_or("");
        let date = commit
            .and_then(|c| c.get("author"))
            .and_then(|a| a.get("date"))
            .and_then(|d| d.as_str())
            .unwrap_or("");
        let repo = it
            .get("repository")
            .and_then(|r| r.get("full_name"))
            .and_then(|n| n.as_str())
            .unwrap_or("");
        if sha.is_empty() || date.is_empty() {
            continue;
        }
        out.push(Entry {
            id: format!("github:commit:{sha}"),
            ts: date.to_string(),
            ingested_at: ingested_at.to_string(),
            source: SOURCE.to_string(),
            kind: "commit".to_string(),
            summary: message.lines().next().unwrap_or("").to_string(),
            entities: vec![repo.to_string()],
            refs: vec![],
            payload: json!({ "repo": repo, "sha": sha, "commit": commit }),
        });
    }
    out
}

/// PRs authored by the user. search/issues (type:pr) carries title,
/// node_id, created_at and pull_request.merged_at — enough to emit an
/// "opened" entry always and a "merged" entry when merged.
async fn fetch_prs(
    client: &reqwest::Client,
    stored: &StoredToken,
    ingested_at: &str,
) -> Result<Vec<Entry>, String> {
    let q = format!("author:{} type:pr", stored.login);
    let data = github_get(
        client,
        "https://api.github.com/search/issues",
        &[
            ("q", q.as_str()),
            ("sort", "updated"),
            ("order", "desc"),
            ("per_page", "30"),
        ],
        &stored.access_token,
    )
    .await?;
    Ok(map_prs(&data, ingested_at))
}

fn map_prs(data: &serde_json::Value, ingested_at: &str) -> Vec<Entry> {
    let mut out = Vec::new();
    let Some(items) = data.get("items").and_then(|i| i.as_array()) else {
        return out;
    };
    for it in items {
        let node_id = it.get("node_id").and_then(|n| n.as_str()).unwrap_or("");
        if node_id.is_empty() {
            continue;
        }
        let title = it.get("title").and_then(|t| t.as_str()).unwrap_or("");
        let created_at = it.get("created_at").and_then(|c| c.as_str()).unwrap_or("");
        let repo = it
            .get("repository_url")
            .and_then(|u| u.as_str())
            .and_then(|u| u.rsplit_once("/repos/").map(|(_, r)| r))
            .unwrap_or("");
        let merged_at = it
            .get("pull_request")
            .and_then(|p| p.get("merged_at"))
            .and_then(|m| m.as_str());

        // Always emit the "opened" point.
        if !created_at.is_empty() {
            out.push(Entry {
                id: format!("github:pr_opened:{node_id}"),
                ts: created_at.to_string(),
                ingested_at: ingested_at.to_string(),
                source: SOURCE.to_string(),
                kind: "pr_opened".to_string(),
                summary: title.to_string(),
                entities: vec![repo.to_string()],
                refs: vec![],
                payload: json!({ "repo": repo, "pullRequest": it }),
            });
        }
        // And a "merged" point when the PR was merged.
        if let Some(merged) = merged_at {
            out.push(Entry {
                id: format!("github:pr_merged:{node_id}"),
                ts: merged.to_string(),
                ingested_at: ingested_at.to_string(),
                source: SOURCE.to_string(),
                kind: "pr_merged".to_string(),
                summary: title.to_string(),
                entities: vec![repo.to_string()],
                refs: vec![],
                payload: json!({ "repo": repo, "pullRequest": it }),
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn map_commits_extracts_sha_message_date_repo() {
        let data = json!({
            "items": [
                {
                    "sha": "aaa111",
                    "repository": { "full_name": "me/repo" },
                    "commit": {
                        "message": "fix: bug\n\nbody line",
                        "author": { "date": "2026-06-03T10:00:00Z" }
                    }
                },
                { "sha": "", "commit": {} } // malformed → skipped
            ]
        });
        let entries = map_commits(&data, "2026-06-03T22:00:00Z");
        assert_eq!(entries.len(), 1);
        let c = &entries[0];
        assert_eq!(c.id, "github:commit:aaa111");
        assert_eq!(c.kind, "commit");
        assert_eq!(c.summary, "fix: bug"); // first line only
        assert_eq!(c.ts, "2026-06-03T10:00:00Z");
        assert_eq!(c.entities, vec!["me/repo".to_string()]);
    }

    #[test]
    fn map_prs_emits_opened_always_and_merged_when_merged() {
        let data = json!({
            "items": [
                {
                    "node_id": "PR_merged", "title": "Add X",
                    "created_at": "2026-06-02T09:00:00Z",
                    "repository_url": "https://api.github.com/repos/me/repo",
                    "pull_request": { "merged_at": "2026-06-03T10:00:00Z" }
                },
                {
                    "node_id": "PR_open", "title": "Open one",
                    "created_at": "2026-06-01T08:00:00Z",
                    "repository_url": "https://api.github.com/repos/me/repo",
                    "pull_request": { "merged_at": null }
                }
            ]
        });
        let entries = map_prs(&data, "2026-06-03T22:00:00Z");
        // merged PR → opened + merged (2); open PR → opened only (1)
        assert_eq!(entries.len(), 3);

        let opened = entries
            .iter()
            .find(|e| e.id == "github:pr_opened:PR_merged")
            .unwrap();
        assert_eq!(opened.kind, "pr_opened");
        assert_eq!(opened.ts, "2026-06-02T09:00:00Z");
        assert_eq!(opened.entities, vec!["me/repo".to_string()]);

        let merged = entries
            .iter()
            .find(|e| e.id == "github:pr_merged:PR_merged")
            .unwrap();
        assert_eq!(merged.ts, "2026-06-03T10:00:00Z");

        assert!(entries.iter().any(|e| e.id == "github:pr_opened:PR_open"));
        assert!(!entries.iter().any(|e| e.id == "github:pr_merged:PR_open"));
    }
}
