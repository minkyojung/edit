//! Track B — vault backup to a GitHub repo. First slice ("walking
//! skeleton"): create a new empty private repo and push the vault to it.
//!
//! Orchestration only: the git plumbing lives in `git.rs` (remote_set /
//! push with a credential helper) and the GitHub API + token in
//! `github.rs`. This module ties them together and owns the vault-identity
//! marker (`.manila/manifest.json`) so a repo can be recognised as "this
//! vault" on restore. It deliberately does NOT do conflict handling yet —
//! receive (`vault_pull`) is fast-forward only and bails on divergence.

use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::AppHandle;

use crate::{git, github};

/// Directory + file the vault-identity marker lives in. `.manila/` is NOT
/// gitignored (only `.manila-tmp/` is — see `git.rs` DEFAULT_GITIGNORE),
/// so the manifest is tracked and travels with the repo.
const MANIFEST_DIR: &str = ".manila";
const MANIFEST_FILE: &str = "manifest.json";

/// Identity marker stored inside the vault and committed into the repo.
/// `vault_id` is what makes "is this repo my vault?" a deterministic check
/// in later slices, rather than a guess.
#[derive(Serialize, Deserialize, Clone)]
pub struct VaultManifest {
    pub vault_id: String,
    /// Unix seconds at creation — informational; no date dependency.
    pub created_at: u64,
}

/// State returned to the frontend after a successful backup. Mirrors the
/// shape the `syncStore` persists.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncState {
    pub repo_full_name: String,
    pub remote_url: String,
    pub branch: String,
    pub vault_id: String,
    pub status: String,
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 128-bit random id rendered as 32 lowercase hex chars.
fn new_vault_id() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Read the manifest if present (read-only, lenient). Returns None when the
/// file is missing or unparseable — used by restore to check "is this cloned
/// repo actually one of our vaults?" without minting anything.
fn read_manifest(vault_path: &str) -> Option<VaultManifest> {
    let path = Path::new(vault_path).join(MANIFEST_DIR).join(MANIFEST_FILE);
    let bytes = std::fs::read(&path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Read the vault manifest, creating it (with a fresh `vault_id`) on first
/// run. Idempotent: a second call returns the same id rather than minting
/// a new one — the id must be stable for the lifetime of the vault.
fn read_or_create_manifest(vault_path: &str) -> Result<VaultManifest, String> {
    let dir = Path::new(vault_path).join(MANIFEST_DIR);
    let path = dir.join(MANIFEST_FILE);
    if path.exists() {
        let bytes = std::fs::read(&path).map_err(|e| format!("read manifest: {e}"))?;
        return serde_json::from_slice(&bytes).map_err(|e| format!("parse manifest: {e}"));
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {MANIFEST_DIR} dir: {e}"))?;
    let manifest = VaultManifest {
        vault_id: new_vault_id(),
        created_at: now_unix(),
    };
    let json =
        serde_json::to_vec_pretty(&manifest).map_err(|e| format!("serialize manifest: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("write manifest: {e}"))?;
    Ok(manifest)
}

/// Derive a GitHub-safe repo name from the vault folder name. GitHub
/// allows letters, digits, `.`, `-`, `_`; anything else becomes `-`.
/// Falls back to `manila-vault` when the folder name yields nothing usable.
fn repo_name_from_vault(vault_path: &str) -> String {
    let base = Path::new(vault_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");
    let sanitized: String = base
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = sanitized.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "manila-vault".to_string()
    } else {
        trimmed
    }
}

/// First-backup flow (skeleton): write+commit the identity marker, create a
/// new empty private repo, wire it as `origin`, and push `main`.
///
/// Failure-soft only where safe: a missing token is a clear "connect first"
/// error; repo-creation / push errors bubble up verbatim (the frontend
/// shows them and offers reconnect when GitHub reports insufficient scope).
#[tauri::command]
pub async fn vault_backup_init(app: AppHandle, vault_path: String) -> Result<SyncState, String> {
    let Some(stored) = github::load_token(&app)? else {
        return Err("Connect GitHub before backing up.".to_string());
    };

    // 1. Identity marker, committed so the repo is recognisably ours.
    let manifest = read_or_create_manifest(&vault_path)?;
    let _ = git::git_commit(vault_path.clone(), "chore: add vault manifest".to_string()).await?;

    // 2. Create the empty remote repo (private by default — it's a backup).
    let name = repo_name_from_vault(&vault_path);
    let repo = github::create_repo(&stored.access_token, &name, true).await?;

    // 3. Wire the remote (token-free URL) and push the vault's actual
    //    branch (main or older master) with the credential helper.
    let branch = git::git_current_branch(&vault_path).await?;
    git::git_remote_set(&vault_path, &repo.clone_url).await?;
    git::git_push(&vault_path, &stored.access_token, &branch).await?;

    Ok(SyncState {
        repo_full_name: repo.full_name,
        remote_url: repo.clone_url,
        branch,
        vault_id: manifest.vault_id,
        status: "connected".to_string(),
    })
}

/// Push the vault's current branch to its existing `origin`, authenticating
/// with the stored token. Used by auto-push after each commit, so it does
/// the minimum: no repo creation, no manifest. No-op (Ok) when GitHub isn't
/// connected; assumes `origin` was wired by a prior `vault_backup_init`
/// (a missing origin surfaces as the underlying git error).
#[tauri::command]
pub async fn vault_push(app: AppHandle, vault_path: String) -> Result<(), String> {
    let Some(stored) = github::load_token(&app)? else {
        return Ok(()); // not connected — nothing to push
    };
    let branch = git::git_current_branch(&vault_path).await?;
    git::git_push(&vault_path, &stored.access_token, &branch).await
}

/// True when `path` exists and contains ANY entry. Strict on purpose: even a
/// stray file means "not empty", matching `git clone`'s own requirement so the
/// guard and the clone agree. Used by restore to refuse cloning into a folder
/// that already holds notes — restore must never clobber.
fn dir_has_content(path: &Path) -> Result<bool, String> {
    if !path.exists() {
        return Ok(false);
    }
    let mut entries = std::fs::read_dir(path).map_err(|e| format!("read dir: {e}"))?;
    Ok(entries.next().is_some())
}

/// Restore a vault from an existing GitHub repo by cloning it into
/// `vault_path` (new device / fresh install).
///
/// SAFETY — never clobbers: refuses when the target is already a repo (`.git`
/// present) or isn't empty. Cloning into an empty/new folder is the only path,
/// so local notes can't be overwritten (that's the conflict slice's job, not
/// restore's). After cloning, verifies the repo carries our identity marker so
/// we don't silently adopt an unrelated repo as the vault.
#[tauri::command]
pub async fn vault_restore(
    app: AppHandle,
    vault_path: String,
    repo_full_name: String,
    clone_url: String,
) -> Result<SyncState, String> {
    let Some(stored) = github::load_token(&app)? else {
        return Err("Connect GitHub before restoring.".to_string());
    };

    let path = Path::new(&vault_path);
    // The repo lives OUTSIDE the vault now, so "already a repository" means the
    // external app-data git-dir for this path already exists.
    if crate::appdata::vault_git_dir(&vault_path).join(".git").exists() {
        return Err("This folder is already a repository — sync instead of restoring.".to_string());
    }
    if dir_has_content(path)? {
        return Err(
            "Restore needs an empty folder so it can't overwrite notes — pick a new/empty folder."
                .to_string(),
        );
    }

    // Pull the whole history down (token via credential helper, never argv).
    git::git_clone(&clone_url, &vault_path, &stored.access_token).await?;
    // Clone writes `<vault>/.git`; move it OUT to app-data so the restored
    // vault has the same sync-clean layout as a locally-created one.
    git::relocate_git_dir(&vault_path).await?;

    // Identity check: a real vault carries `.manila/manifest.json`. Without it
    // this is some unrelated repo — surface that rather than adopting it.
    let manifest = read_manifest(&vault_path).ok_or_else(|| {
        "That repository isn't a notes backup from this app (no vault marker).".to_string()
    })?;

    let branch = git::git_current_branch(&vault_path).await?;

    Ok(SyncState {
        repo_full_name,
        remote_url: clone_url,
        branch,
        vault_id: manifest.vault_id,
        status: "connected".to_string(),
    })
}

/// Receive remote changes into the connected vault — fast-forward ONLY.
/// Returns `Ok(true)` when it advanced or was already current, `Ok(false)` when
/// local and remote have diverged (two devices edited → the conflict slice
/// handles that) or GitHub isn't connected. Never writes a merge commit or
/// conflict markers, so the notes are never left half-merged.
#[tauri::command]
pub async fn vault_pull(app: AppHandle, vault_path: String) -> Result<bool, String> {
    let Some(stored) = github::load_token(&app)? else {
        return Ok(false); // not connected — nothing to receive
    };
    let branch = git::git_current_branch(&vault_path).await?;
    git::git_pull_ff(&vault_path, &stored.access_token, &branch).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_vault(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("vault_sync_test_{}_{}", std::process::id(), name));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn manifest_is_created_then_reused() {
        let dir = temp_vault("manifest");
        let vault = dir.to_str().unwrap();

        let first = read_or_create_manifest(vault).unwrap();
        assert_eq!(first.vault_id.len(), 32);
        assert!(first.vault_id.chars().all(|c| c.is_ascii_hexdigit()));

        // Second call must return the SAME id — not mint a new one.
        let second = read_or_create_manifest(vault).unwrap();
        assert_eq!(first.vault_id, second.vault_id);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn repo_name_sanitizes_and_falls_back() {
        assert_eq!(repo_name_from_vault("/Users/me/Writer"), "Writer");
        assert_eq!(repo_name_from_vault("/Users/me/My Notes!"), "My-Notes");
        assert_eq!(repo_name_from_vault("/"), "manila-vault");
    }
}
