// Tauri commands invoked from the frontend.
//
// Streaming output flows back as Tauri events:
//   - "claude:event" for each Agent SDK event
//   - "claude:done"  on successful completion
//   - "claude:error" on failure or cancellation
// Each event payload carries a `runId` to identify which chat it belongs to.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;

use tauri::{AppHandle, Manager};

use super::client::SidecarError;
use super::manager::SidecarManager;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatStartArgs {
    pub run_id: String,
    pub model: String,
    /// Either a plain string or a ContentBlock array (when the user attached
    /// files). Passed through verbatim; the SDK's MessageParam accepts both
    /// forms for `content`.
    pub prompt: Value,
    /// Either a single string or an array of strings (with
    /// SYSTEM_PROMPT_DYNAMIC_BOUNDARY sentinel). The frontend chooses
    /// the shape; we pass it through to the SDK verbatim, which
    /// accepts both forms.
    #[serde(default)]
    pub system_prompt: Option<Value>,
    /// Names of relay tools to enable for this chat (e.g. ["propose_change"]).
    /// Sidecar handles the registration; frontend does not pass tool schemas.
    #[serde(default)]
    pub relay_tools: Option<Vec<String>>,
    /// Absolute path of the active vault folder. Forwarded to the sidecar so
    /// tools like `read_page` / `search_wiki` can read markdown directly from
    /// disk (Claude SDK-native pattern — tool handlers ARE the data source).
    /// Optional because chats without filesystem-touching tools don't need it;
    /// when omitted, the corresponding relay tools are silently disabled.
    #[serde(default)]
    pub vault_path: Option<String>,
    #[serde(default)]
    pub permission_mode: Option<String>,
    /// Reasoning effort hint forwarded as-is to the SDK's `effort` option.
    /// Accepted: "low" / "medium" / "high" / "xhigh" / "max". Sidecar drops
    /// the field entirely when None, letting the SDK pick its default.
    #[serde(default)]
    pub effort: Option<String>,
    /// SDK session UUID to create with this run. Set on the first turn
    /// of a thread; the SDK persists the session under
    /// ~/.claude/projects/ so subsequent turns can resume it.
    /// Mutually exclusive with `resume`.
    #[serde(default)]
    pub session_id: Option<String>,
    /// SDK session UUID to resume. Set on every turn after the first
    /// in a thread. Loads prior conversation server-side so the
    /// frontend doesn't have to ship a transcript in the prompt.
    #[serde(default)]
    pub resume: Option<String>,
    /// Optional cap on the SDK agent loop's conversation turns. Used
    /// by the ingest path so a runaway tool-calling pass settles
    /// instead of churning forever. Forwarded to the sidecar which
    /// passes it to the SDK's `maxTurns` option (sdk.d.ts:1412).
    /// `None` means the SDK's own default applies — which is what
    /// chat wants (multi-turn conversation, no host-imposed cap).
    #[serde(default)]
    pub max_turns: Option<u32>,
    /// Optional explicit list of SDK built-in tool names to expose to
    /// the model. When set, only those tools are visible (sdk.d.ts:
    /// 1216 — `tools: string[]` shape). When omitted, the sidecar
    /// falls back to the full `claude_code` preset (Read / Edit /
    /// Write / Bash / Grep / Glob). Ingest passes a read-only subset
    /// (typically `["Read", "Glob", "Grep"]`) so the model cannot
    /// write to disk directly — proposals go through
    /// `submit_ingest_result` and the host applies them after user
    /// review.
    #[serde(default)]
    pub builtin_tools: Option<Vec<String>>,
    /// Security lockdown: block network egress + secret-file reads (SDK
    /// sandbox + deny rules) so a prompt injection in captured content
    /// can't exfiltrate. Omitted → the sidecar defaults it ON (secure by
    /// default); the frontend forwards the user's Settings toggle.
    #[serde(default)]
    pub sandbox_enabled: Option<bool>,
    /// Whether this run may delegate (Task) or activate skills (Skill).
    /// Omitted → the sidecar defaults it ON for the trusted chat/plan
    /// surfaces. The frontend sends `Some(false)` for untrusted-content
    /// shapes (capture/intake) so injected content can't Task-delegate to a
    /// full-toolset subagent and escape the least-privilege builtin set.
    #[serde(default)]
    pub allow_delegation: Option<bool>,
    /// Request fast mode (faster output) for this run. Forwarded to the
    /// sidecar which sets the SDK's `settings.fastMode`. The frontend only
    /// sends `Some(true)` after gating on model support; `None` = off.
    #[serde(default)]
    pub fast_mode: Option<bool>,
    /// Conversation/thread id (= the SDK session UUID). When `persistent_query`
    /// is set, the sidecar keeps one long-lived query alive per thread so a
    /// `result` is a turn boundary and background subagent tasks survive across
    /// turns. Falls back to session_id/resume when omitted.
    #[serde(default)]
    pub thread_id: Option<String>,
    /// Opt into the persistent per-thread query path (chat mode only). Omitted
    /// or false → the legacy per-turn path runs unchanged.
    #[serde(default)]
    pub persistent_query: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatCancelArgs {
    pub run_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseThreadArgs {
    pub thread_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StopTaskArgs {
    pub thread_id: String,
    pub task_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatDecisionArgs {
    pub run_id: String,
    pub decision_id: String,
    /// Opaque decision payload forwarded verbatim to the sidecar's
    /// canUseTool gate. Shapes: `{ "type": "approve" }` /
    /// `{ "type": "reject", "message": "..." }` (ExitPlanMode) or
    /// `{ "answers": { ... } }` (AskUserQuestion).
    pub decision: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatEditAckArgs {
    pub pending_id: String,
    /// Whether the host actually queued this propose_edit/write/multi_edit
    /// call into pendingChangesStore. This IS the tool call's result: the
    /// handler is blocked on it and returns text chosen by this verdict, so
    /// false reaches the model as a refusal rather than as a correction to
    /// something it was already told.
    pub ok: bool,
    /// Optional short reason surfaced in that refusal.
    #[serde(default)]
    pub reason: Option<String>,
    /// True when auto-accept mode actually wrote the change to disk (not merely
    /// queued). The sidecar rewrites the tool's "queued for user review" text
    /// into "applied immediately" so the model doesn't tell the user to reject a
    /// review card that never existed. Defaults false (interactive review path).
    #[serde(default)]
    pub applied: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TitleArgs {
    pub run_id: String,
    pub model: String,
    pub prompt: String,
    #[serde(default)]
    pub system_prompt: Option<String>,
}

/// What a Tauri command failed with, as structure rather than prose.
///
/// Every command used to end in `.map_err(|e| e.to_string())`, so the frontend
/// received `SidecarError`'s Display output and had to read it back — there was
/// a `/^rpc error:/` regex in errorMessage.ts matching this crate's
/// `#[error("rpc error: {code} {message}")]` and replacing the whole thing with
/// a generic line. That threw away the one message the user could act on: the
/// sidecar's refusal when every chat thread is busy.
///
/// Tagged on `kind` like `SidecarState` (state.rs), for the same reason — the
/// consumer switches on one field. Unlike that type, the TS side here is
/// exhaustive (a `never` check), so this doc comment cannot quietly become
/// untrue the way `state.rs`'s "mirrored 1:1" claim did.
///
/// `SidecarError::Rpc`'s `data` is deliberately not carried: no `errorResponse`
/// call in the sidecar passes one, so a field for it would be permanently null.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CommandError {
    /// The sidecars have not finished starting; the caller may retry shortly.
    NotReady,
    /// The sidecar answered our request with an error. `message` is written for
    /// the user — pass it through rather than summarising it.
    Rpc { code: i64, message: String },
    /// The sidecar process is gone.
    Exited,
    /// A stale `sidecar-pkg/`. Both numbers are carried because naming only one
    /// makes the report unactionable.
    ProtocolMismatch { expected: u32, got: Option<u32> },
    /// Framing, serialization, or a closed pipe — nothing the user can act on
    /// beyond retrying, but the detail belongs in a bug report.
    Transport { message: String },
    /// An answer arrived for a request the host had already released — the run
    /// was cancelled, or the sidecar restarted. Reported rather than swallowed
    /// so a card that outlives its gate is visible in the log, but the frontend
    /// treats it as expected: the sidecar was already told.
    NoLongerWaiting { message: String },
}

impl From<SidecarError> for CommandError {
    fn from(e: SidecarError) -> Self {
        match e {
            SidecarError::Exited => CommandError::Exited,
            SidecarError::Rpc { code, message, .. } => CommandError::Rpc { code, message },
            SidecarError::ProtocolMismatch { expected, got } => {
                CommandError::ProtocolMismatch { expected, got }
            }
            other => CommandError::Transport { message: other.to_string() },
        }
    }
}

fn get_manager(app: &AppHandle) -> Result<Arc<SidecarManager>, CommandError> {
    let state = app
        .try_state::<Arc<SidecarManager>>()
        .ok_or(CommandError::NotReady)?;
    Ok(state.inner().clone())
}

/// Starts a chat on the chat sidecar. Returns the immediate ack
/// (`{ runId, accepted }`); subsequent streaming output arrives as events.
#[tauri::command]
pub async fn claude_chat_start(app: AppHandle, args: ChatStartArgs) -> Result<Value, CommandError> {
    let manager = get_manager(&app)?;
    // Push the freshest token to the CHAT sidecar before every chat — handles
    // silent rotation without a restart. Chat-only so a title sidecar that's
    // mid-restart can't block a chat start.
    manager
        .try_inject_token_chat(&app)
        .await
        ?;

    let mut params = json!({
        "runId": args.run_id,
        "model": args.model,
        "prompt": args.prompt,
    });
    if let Some(sp) = args.system_prompt {
        params["systemPrompt"] = sp;
    }
    if let Some(tools) = args.relay_tools {
        params["relayTools"] = json!(tools);
    }
    if let Some(vp) = args.vault_path {
        // The vault's `.git` lives OUTSIDE the vault (appdata::vault_git_dir) so a
        // file-sync can't corrupt it. Pass the resolved git-dir + work-tree so the
        // model's Bash `git` targets the real repo with no `--git-dir` flag — this
        // is what makes the undo-ai-change skill work (plain `git log`/`git revert`
        // from the vault cwd). Single source of truth: the path is derived here in
        // Rust, never recomputed in the sidecar.
        let git_dir = crate::appdata::vault_git_dir(&vp).join(".git");
        params["gitDir"] = Value::String(git_dir.to_string_lossy().into_owned());
        params["gitWorkTree"] = Value::String(vp.clone());
        params["vaultPath"] = Value::String(vp);
    }
    if let Some(mode) = args.permission_mode {
        params["permissionMode"] = Value::String(mode);
    }
    if let Some(effort) = args.effort {
        params["effort"] = Value::String(effort);
    }
    if let Some(sid) = args.session_id {
        params["sessionId"] = Value::String(sid);
    }
    if let Some(r) = args.resume {
        params["resume"] = Value::String(r);
    }
    if let Some(mt) = args.max_turns {
        params["maxTurns"] = json!(mt);
    }
    if let Some(bt) = args.builtin_tools {
        params["builtinTools"] = json!(bt);
    }
    if let Some(se) = args.sandbox_enabled {
        params["sandboxEnabled"] = json!(se);
    }
    if let Some(ad) = args.allow_delegation {
        params["allowDelegation"] = json!(ad);
    }
    if let Some(fm) = args.fast_mode {
        params["fastMode"] = json!(fm);
    }
    if let Some(tid) = args.thread_id {
        params["threadId"] = Value::String(tid);
    }
    if let Some(pq) = args.persistent_query {
        params["persistentQuery"] = json!(pq);
    }

    let chat = manager.chat_client().await;
    Ok(chat.request("chat", Some(params))
        .await?)
}

/// Close a persistent thread's long-lived query (archive / doc-close / delete).
/// Distinct from cancel: this ends the query entirely. The SDK session persists,
/// so a later chat for the same threadId resumes cleanly.
#[tauri::command]
pub async fn claude_chat_close_thread(app: AppHandle, args: CloseThreadArgs) -> Result<(), CommandError> {
    let manager = get_manager(&app)?;
    let chat = manager.chat_client().await;
    Ok(chat.notify(
        "chat/close-thread",
        Some(json!({ "threadId": args.thread_id })),
    )
    .await?)
}

/// Stop a specific in-flight background subagent task (the user hit Stop on its
/// row). The sidecar calls the SDK's stopTask; a task_notification with status
/// 'stopped' follows on the chat/task channel.
#[tauri::command]
pub async fn claude_chat_stop_task(app: AppHandle, args: StopTaskArgs) -> Result<(), CommandError> {
    let manager = get_manager(&app)?;
    let chat = manager.chat_client().await;
    Ok(chat.notify(
        "chat/stop-task",
        Some(json!({ "threadId": args.thread_id, "taskId": args.task_id })),
    )
    .await?)
}

/// Lists the models this account can actually use, from the SDK's session-init
/// handshake (`query.supportedModels()`). The host filters its model picker to
/// this set; on any error it falls back to the built-in list, so this is purely
/// additive — a failure never blocks model selection.
#[tauri::command]
pub async fn claude_list_models(app: AppHandle) -> Result<Value, CommandError> {
    let manager = get_manager(&app)?;
    // Chat-only injection: models is answered by the chat sidecar, so it must
    // not depend on the title sidecar being healthy.
    manager
        .try_inject_token_chat(&app)
        .await
        ?;
    let chat = manager.chat_client().await;
    Ok(chat.request("models", None)
        .await?)
}

/// Cancels an in-flight chat. Notification only — no response expected.
#[tauri::command]
pub async fn claude_chat_cancel(app: AppHandle, args: ChatCancelArgs) -> Result<(), CommandError> {
    let manager = get_manager(&app)?;
    // Fail this run's parked host requests before cancelling. The frontend
    // listener filters by runId, so once the run is cancelled nothing will
    // ever answer them, and the sidecar's `query_notes` await would sit there
    // until the process died.
    manager.pending_frontend().release_run(&args.run_id).await;
    let chat = manager.chat_client().await;
    Ok(chat.notify("chat/cancel", Some(json!({ "runId": args.run_id })))
        .await?)
}

/// Answers a parked plan-mode gate (ExitPlanMode / AskUserQuestion). Routes
/// the user's decision back to the sidecar's canUseTool callback so the turn
/// resumes. Notification only — no response expected.
#[tauri::command]
pub async fn claude_chat_decision(app: AppHandle, args: ChatDecisionArgs) -> Result<(), CommandError> {
    let manager = get_manager(&app)?;
    // The decision IS the answer to the sidecar's parked `host/permission`
    // request — the SDK's canUseTool callback is blocked on it.
    let answered = manager.pending_frontend().answer(&args.decision_id, args.decision).await;
    if !answered {
        // The gate is gone: the turn was cancelled while the card was up, or
        // the sidecar restarted. The card outliving its gate is the reason
        // this reports rather than succeeding silently.
        return Err(CommandError::NoLongerWaiting { message: format!("gate {} is no longer waiting for a decision", args.decision_id) });
    }
    Ok(())
}

/// Confirms (or denies) that a propose_edit/write/multi_edit proposal was
/// actually queued into pendingChangesStore, once agent/chat/index.ts's
/// edit-pending handling settles. Answers the sidecar's parked
/// `host/editPending` request, whose caller otherwise fails open after
/// its own timeout. Notification only — no response expected.
#[tauri::command]
pub async fn claude_chat_edit_ack(app: AppHandle, args: ChatEditAckArgs) -> Result<(), CommandError> {
    let manager = get_manager(&app)?;
    let answered = manager
        .pending_frontend()
        .answer(
            &args.pending_id,
            json!({ "ok": args.ok, "reason": args.reason, "applied": args.applied }),
        )
        .await;
    if !answered {
        // Already released — the run was cancelled or the sidecar restarted.
        // The tool call has been told so; this ack is just late.
        return Err(CommandError::NoLongerWaiting { message: format!("proposal {} is no longer waiting for a verdict", args.pending_id) });
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatQueryResultArgs {
    /// The key the host parked the request under, echoed back verbatim.
    /// Not the sidecar's JSON-RPC id — see `PendingFrontend`.
    pub query_id: String,
    /// The filtered note references. Each entry is opaque to Rust and
    /// forwarded verbatim, but the array itself is pinned: the tool does
    /// `results.length`, and the sidecar used to normalise a non-array away
    /// before this became a typed command boundary. Serde does it now.
    pub results: Vec<Value>,
    #[serde(default)]
    pub next_cursor: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostAnswerArgs {
    /// The key the host parked the request under, echoed back verbatim.
    pub request_id: String,
    /// Opaque to Rust — the sidecar's tool decides what it means.
    pub result: Value,
}

/// Answers a parked `host/*` request with a payload the host does not read.
///
/// Deliberately generic, where `claude_chat_query_result` /
/// `claude_chat_edit_ack` / `claude_chat_decision` each name their own fields.
/// Those three predate the transport and are typed at this boundary for
/// reasons that still hold — `results` must be an array, an ack has three
/// specific flags. A metadata write's answer is `{ok, reason}` and Rust has no
/// stake in either field, so typing it here would only mean editing this file
/// every time a relay tool gains a case.
#[tauri::command]
pub async fn claude_chat_host_answer(app: AppHandle, args: HostAnswerArgs) -> Result<(), CommandError> {
    let manager = get_manager(&app)?;
    if !manager.pending_frontend().answer(&args.request_id, args.result).await {
        // Already released — the run was cancelled or the sidecar restarted.
        return Err(CommandError::NoLongerWaiting { message: format!("request {} is no longer waiting", args.request_id) });
    }
    Ok(())
}

/// Answers a `host/queryNotes` request the sidecar parked with the host. This
/// is the second half of a JSON-RPC request the host could not answer itself:
/// the note catalogue lives in the frontend's docs store, so the reply travels
/// out as a Tauri event and comes back here.
///
/// An unknown token is reported rather than swallowed. It means the slot was
/// already released — the run was cancelled, or the sidecar restarted — and the
/// sidecar has been told so. The frontend's work is wasted but nothing hangs.
#[tauri::command]
pub async fn claude_chat_query_result(
    app: AppHandle,
    args: ChatQueryResultArgs,
) -> Result<(), CommandError> {
    let manager = get_manager(&app)?;
    let answered = manager
        .pending_frontend()
        .answer(
            &args.query_id,
            json!({ "results": args.results, "nextCursor": args.next_cursor }),
        )
        .await;
    if !answered {
        return Err(CommandError::NoLongerWaiting { message: format!("query {} is no longer waiting for an answer", args.query_id) });
    }
    Ok(())
}

/// Runs a single-shot chat on the title sidecar. Used for thread-title
/// generation. Returns the same ack shape as `claude_chat_start`; events
/// flow on the same `claude:*` channel.
#[tauri::command]
pub async fn claude_title(app: AppHandle, args: TitleArgs) -> Result<Value, CommandError> {
    let manager = get_manager(&app)?;
    // Title-only injection: this runs on the title sidecar, so a chat sidecar
    // mid-restart must not block it (and vice versa).
    manager
        .try_inject_token_title(&app)
        .await
        ?;

    let mut params = json!({
        "runId": args.run_id,
        "model": args.model,
        "prompt": args.prompt,
    });
    if let Some(sp) = args.system_prompt {
        params["systemPrompt"] = Value::String(sp);
    }

    let title = manager.title_client().await;
    Ok(title.request("chat", Some(params)).await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The wire shape is the contract with errorMessage.ts. Pinned here the way
    /// state.rs pins SidecarState's, because the TS side cannot observe a
    /// rename — it would just stop matching and fall through to generic copy.
    #[test]
    fn every_variant_serializes_to_the_shape_the_frontend_switches_on() {
        let cases = [
            (CommandError::NotReady, serde_json::json!({ "kind": "notReady" })),
            (
                CommandError::Rpc { code: -32001, message: "all busy".into() },
                serde_json::json!({ "kind": "rpc", "code": -32001, "message": "all busy" }),
            ),
            (CommandError::Exited, serde_json::json!({ "kind": "exited" })),
            (
                CommandError::ProtocolMismatch { expected: 2, got: Some(1) },
                serde_json::json!({ "kind": "protocolMismatch", "expected": 2, "got": 1 }),
            ),
            (
                CommandError::Transport { message: "broken pipe".into() },
                serde_json::json!({ "kind": "transport", "message": "broken pipe" }),
            ),
            (
                CommandError::NoLongerWaiting { message: "gate x is gone".into() },
                serde_json::json!({ "kind": "noLongerWaiting", "message": "gate x is gone" }),
            ),
        ];
        for (err, want) in cases {
            assert_eq!(serde_json::to_value(&err).unwrap(), want);
        }
    }

    /// The refusal the user reads must survive the conversion intact — this is
    /// the message that says which chats are busy and what to do about it.
    #[test]
    fn an_rpc_refusal_keeps_its_code_and_its_wording() {
        let msg = "5 conversations are already working. Wait for one to finish.";
        let converted: CommandError = SidecarError::Rpc {
            code: -32001,
            message: msg.into(),
            data: None,
        }
        .into();
        assert!(
            matches!(&converted, CommandError::Rpc { code: -32001, message } if message == msg),
            "got {converted:?}",
        );
    }

    /// The three that carry no structure of their own collapse into one
    /// variant rather than each inventing a string the frontend must read.
    #[test]
    fn framing_and_pipe_failures_all_land_in_transport() {
        for e in [SidecarError::Send, SidecarError::Exited] {
            let is_exited = matches!(e, SidecarError::Exited);
            let converted: CommandError = e.into();
            match (&converted, is_exited) {
                (CommandError::Exited, true) => {}
                (CommandError::Transport { .. }, false) => {}
                _ => panic!("unexpected mapping: {converted:?}"),
            }
        }
    }
}
