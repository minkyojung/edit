//! Git commands for the vault folder. The vault is the user's
//! markdown corpus (wiki/, daily/, _system/, threads/) — making it a
//! git repository gives us:
//!
//!   - free undo for LLM edits (revert a commit)
//!   - "what changed since I last looked?" view (log against a
//!     bookmark ref `refs/heads/last-reviewed`)
//!   - future GitHub remote with zero extra storage layer
//!
//! All git operations shell out to the system `git` binary via
//! `tokio::process::Command` — same pattern `claude_sidecar/client.rs`
//! uses for the sidecar process. Avoids the `tauri-plugin-shell`
//! permission ceremony (capabilities/default.json would otherwise
//! need `shell:allow-execute` plus a per-program allowlist) and lets
//! us pass `-C <vault>` cleanly.
//!
//! Target is technical users (Karpathy LLM Wiki audience) so we
//! assume `git` is on PATH. Missing-git is surfaced as a soft error
//! the frontend can turn into a "Install git to enable history"
//! onboarding note.

use serde::Serialize;
use std::path::Path;
use std::process::Stdio;
use tokio::process::Command;

use crate::appdata;

/// Bookmark ref name used for the "last reviewed" pointer. The
/// frontend's ActivityView shows commits in `<this-ref>..HEAD` and
/// the "Mark all reviewed" action advances this ref to HEAD.
///
/// Stored as a regular branch ref so plain `git` CLI users can see
/// and manipulate it too (e.g. `git rev-parse last-reviewed`).
const LAST_REVIEWED_REF: &str = "refs/heads/last-reviewed";

/// .gitignore body seeded on `init_repo`. Kept minimal — the vault
/// IS the user's content, so we only ignore editor + OS junk plus
/// ephemeral per-session state we don't want in history.
const DEFAULT_GITIGNORE: &str = "# Manila vault gitignore — managed by the app, edit freely.\n\
.DS_Store\n\
.manila-tmp/\n\
\n\
# Yjs binary state — mirrors the .md content. Regenerated on edit;\n\
# tracking it just bloats history. The .meta.json sidecar IS tracked\n\
# because it carries durable metadata (aiSummary, archivedAt, …).\n\
*.ydoc\n\
\n\
# GitHub-activity cache (SQLite). Derived from GitHub on demand, binary,\n\
# and the WAL churns constantly — tracking it bloats history and risks\n\
# corruption across devices. The connector rebuilds it when missing.\n\
events.db\n\
events.db-wal\n\
events.db-shm\n\
\n\
# App-internal state — Octave's private namespace. Chat session JSON and\n\
# chat attachment binaries the user drops into the composer. Pure ephemeral\n\
# scratch the user never reads; committing it would flood every chat-driven\n\
# git turn with noise (and bloat history with screenshots/PDFs).\n\
.octave/\n";

/// One entry returned by `log_since_ref`. Pretty-printed by the
/// frontend's ActivityView. Field names are camelCase via serde for
/// the JS consumer.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    /// Full SHA. Frontend uses this for revert calls.
    pub sha: String,
    /// First line of the commit message.
    pub subject: String,
    /// Committer time as Unix seconds. Frontend converts to "5m ago"
    /// or similar at render time.
    pub timestamp: i64,
    /// Files touched, with the status code git emits: `M` modified,
    /// `A` added, `D` deleted, `R<NN>` renamed (we strip the score).
    pub files: Vec<FileChange>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    /// Single-letter status: `M` `A` `D` `R` `C` `T`.
    pub status: String,
    pub path: String,
}

/// Full commit metadata + per-file content diff. Returned by
/// `git_show`. The Review panel uses this for the expanded card.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    pub sha: String,
    /// First line of the message.
    pub subject: String,
    /// Everything after the subject + blank line. Empty when the
    /// commit has no body.
    pub body: String,
    pub timestamp: i64,
    pub files: Vec<FileDiff>,
}

/// One file's diff lines from a commit, in the order they appear in
/// the unified diff (so a "modify" patch reads `-old / +new` in the
/// natural before-after sequence). The frontend renders this as a
/// single list with per-line colouring rather than splitting into
/// separate added/removed sections.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    /// Status code (`M` `A` `D` `R`); same convention as FileChange.
    pub status: String,
    /// Ordered list of changed lines. Context lines aren't included
    /// because we request `--unified=0`.
    pub lines: Vec<DiffLine>,
}

/// One line in a unified diff, classified by direction. Order
/// across siblings matches the diff's hunk sequence.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    /// `"add"` for `+` lines, `"remove"` for `-` lines. (No `"context"`
    /// because we use `--unified=0`.)
    pub kind: &'static str,
    /// Line text with the `+` / `-` prefix stripped.
    pub text: String,
    /// 1-based line number from the unified-diff hunk header.
    /// For `add` lines this is the new-side line; for `remove` lines
    /// it's the old-side line. 0 means "unknown" (only used as a
    /// defensive default if a hunk header couldn't be parsed).
    pub line_num: u32,
}

/// Build a `Command` whose **work-tree is the vault** but whose **git data dir
/// lives OUTSIDE the vault**, in the per-device app-data folder
/// (`appdata::vault_git_dir`). Keeping `.git` out of the vault is what lets the
/// vault sync cleanly via iCloud/Syncthing without corrupting the repo.
///
/// Both `--git-dir` and `--work-tree` are passed explicitly on EVERY command,
/// so (a) git never creates a `.git` file/folder in the vault, and (b) git's
/// working-tree discovery can't walk up to a stray ancestor `.git/`.
///
/// Every git invocation in this module goes through this helper so the
/// location rule lives in exactly one place.
fn git_command(vault_path: &str) -> Command {
    let trimmed = vault_path.trim_end_matches('/');
    let git_dir = appdata::vault_git_dir(vault_path).join(".git");
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(vault_path);
    cmd.arg(format!("--git-dir={}", git_dir.display()));
    cmd.arg(format!("--work-tree={trimmed}"));
    cmd.stdin(Stdio::null());
    cmd
}

/// Run `git` with the given args via {@link git_command}. Captures
/// stdout + stderr. Returns Err with stderr text when git exits
/// non-zero — caller decides whether that's fatal or expected
/// (e.g. `git commit` with nothing staged is a normal no-op).
async fn run_git(vault_path: &str, args: &[&str]) -> Result<String, String> {
    run_git_with_env(vault_path, args, &[]).await
}

/// Like {@link run_git} but also sets process environment variables on the
/// spawned git. Used by `git_push` to hand the auth token to git's inline
/// credential helper via `GH_TOKEN` — keeping the secret out of argv so it
/// never shows up in `ps`.
async fn run_git_with_env(
    vault_path: &str,
    args: &[&str],
    envs: &[(&str, &str)],
) -> Result<String, String> {
    let mut cmd = git_command(vault_path);
    for a in args {
        cmd.arg(a);
    }
    for (k, v) in envs {
        cmd.env(k, v);
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("git spawn failed: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
        let code = output.status.code().unwrap_or(-1);
        return Err(format!("git exit {code}: {}", stderr.trim()));
    }

    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Move directory `src` to `dst`, falling back to a recursive copy + remove
/// when a plain rename can't cross filesystems (e.g. the vault lives on an
/// external/network drive while app-data is on the internal disk).
fn move_dir(src: &Path, dst: &Path) -> Result<(), String> {
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir for move: {e}"))?;
    }
    if std::fs::rename(src, dst).is_ok() {
        return Ok(());
    }
    // Cross-device (EXDEV) or similar — copy then remove the original.
    copy_dir_recursive(src, dst)?;
    std::fs::remove_dir_all(src).map_err(|e| format!("remove after copy: {e}"))?;
    Ok(())
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| format!("create {}: {e}", dst.display()))?;
    for entry in std::fs::read_dir(src).map_err(|e| format!("read {}: {e}", src.display()))? {
        let entry = entry.map_err(|e| format!("read entry: {e}"))?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if entry
            .file_type()
            .map_err(|e| format!("file_type: {e}"))?
            .is_dir()
        {
            copy_dir_recursive(&from, &to)?;
        } else {
            std::fs::copy(&from, &to).map_err(|e| format!("copy {}: {e}", from.display()))?;
        }
    }
    Ok(())
}

/// Move any in-vault `.git` OUT to the external app-data git-dir and pin its
/// work-tree back at the vault. Used for (a) legacy vaults whose `.git` is
/// still inside, and (b) freshly cloned vaults (clone always writes
/// `<dest>/.git`). Idempotent: a no-op when the vault has no in-tree `.git`.
pub async fn relocate_git_dir(vault_path: &str) -> Result<(), String> {
    let in_tree = Path::new(vault_path).join(".git");
    if !in_tree.exists() {
        return Ok(());
    }
    // A `.git` FILE is our own gitdir POINTER (written by write_vault_git_pointer
    // so a bare `git` inside the vault resolves to the external git-dir), not a
    // real in-tree repo — never relocate it.
    if in_tree.is_file() {
        return Ok(());
    }
    let external = appdata::vault_git_dir(vault_path).join(".git");
    if external.exists() {
        // External already set up — don't clobber it (shouldn't normally
        // co-exist with an in-tree .git).
        return Ok(());
    }
    move_dir(&in_tree, &external)?;
    // Pin the moved repo's work-tree back to the vault. (Every command also
    // passes --work-tree explicitly, so this is belt-and-suspenders for any
    // external `git` CLI use against this repo.)
    run_git(vault_path, &["config", "core.worktree", vault_path]).await?;
    Ok(())
}

/// Write a one-line `.git` FILE (a "gitdir pointer") in the vault root so a
/// bare `git` invocation inside the vault resolves to the external app-data
/// git-dir. This is what lets the agent run plain `git log` / `git show` /
/// `git revert` from the vault (via Bash) without knowing the app-data path —
/// checkpoints are discoverable the ordinary way. The heavy `.git/` object
/// store stays in app-data (so the vault remains sync-clean); only this
/// one-line pointer lives in the vault.
///
/// Idempotent: only rewrites when the content differs, so it doesn't touch the
/// file (or wake the vault watcher) on every boot. Caller must ensure the
/// external git-dir already exists.
fn write_vault_git_pointer(vault_path: &str) -> Result<(), String> {
    let external = appdata::vault_git_dir(vault_path).join(".git");
    let pointer = Path::new(vault_path).join(".git");
    // Never overwrite a real in-tree repo dir — relocate_git_dir handles those
    // and runs before this. If a `.git` DIR is somehow still here, bail rather
    // than clobber it.
    if pointer.is_dir() {
        return Ok(());
    }
    let content = format!("gitdir: {}\n", external.display());
    if let Ok(existing) = std::fs::read_to_string(&pointer) {
        if existing == content {
            return Ok(());
        }
    }
    std::fs::write(&pointer, content).map_err(|e| format!("write .git pointer failed: {e}"))?;
    Ok(())
}

/// Initialise a git repo for `vault_path` if one isn't already
/// there. Seeds `.gitignore` and produces an initial commit so
/// subsequent revert / log operations have a base.
///
/// Idempotent: if `.git/` exists we return immediately without
/// touching the repo. The frontend calls this on every boot after
/// the vault picker, so a no-op fast path matters.
#[tauri::command]
pub async fn git_init(vault_path: String) -> Result<(), String> {
    // Migrate a legacy in-vault `.git` (or a just-cloned one) OUT to the
    // per-device app-data git-dir so the vault stays sync-clean. Idempotent
    // no-op when there's no in-tree `.git`.
    relocate_git_dir(&vault_path).await?;

    // Already initialised? The repo now lives OUTSIDE the vault, so check the
    // external git-dir. Fast no-op — called on every boot.
    let external = appdata::vault_git_dir(&vault_path).join(".git");
    if external.exists() {
        // Repo already set up. Ensure the in-vault gitdir pointer exists even
        // for vaults whose repo predates it, so bare `git` inside the vault
        // resolves here.
        write_vault_git_pointer(&vault_path)?;
        return Ok(());
    }

    // Verify git is actually installed before we proceed. Without
    // this the user gets an opaque spawn-failed error on the first
    // real command; running `git --version` once up front lets us
    // surface "is git installed?" as the actual reason.
    let probe = Command::new("git")
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map_err(|e| format!("git probe failed (is git installed?): {e}"))?;
    if !probe.success() {
        return Err("git --version exited non-zero (broken install?)".to_string());
    }

    // Create the repo at the EXTERNAL git-dir with the vault as its work-tree
    // — the dotfiles-repo pattern (`git --git-dir=X --work-tree=W init` leaves
    // NO `.git` in W). git_command already supplies --git-dir/--work-tree, so
    // run_git inits at the right place. `-b main` requires git 2.28+.
    if let Some(parent) = external.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create git-dir parent failed: {e}"))?;
    }
    run_git(&vault_path, &["init", "-b", "main"]).await?;

    // Identity: prefer the user's global config. If absent, fall
    // back to a sentinel identity so the initial commit doesn't
    // fail with "please tell me who you are". Users with a real
    // identity see no change; users without one get a vault-local
    // identity that they can override later.
    //
    // We don't probe `user.email` first because the cost of an
    // unconditional local config is one extra config line in
    // `.git/config` — cheaper than two extra git invocations.
    let _ = run_git(
        &vault_path,
        &["config", "--local", "user.name", "Manila"],
    )
    .await;
    let _ = run_git(
        &vault_path,
        &[
            "config",
            "--local",
            "user.email",
            "manila@localhost",
        ],
    )
    .await;

    // Seed .gitignore via git itself so it lands in the working
    // tree and gets picked up by the initial commit. Writing the
    // file from Rust would also work but couples this module to
    // std::fs; staying inside `git` keeps the surface narrow.
    //
    // hash-object + update-index is the plumbing equivalent of
    // `echo > .gitignore && git add`, but lets us avoid a stdio
    // round trip — git reads its argument directly.
    //
    // Cheaper alternative: just write the file. We do that.
    let gitignore_path = std::path::Path::new(&vault_path).join(".gitignore");
    if !gitignore_path.exists() {
        std::fs::write(&gitignore_path, DEFAULT_GITIGNORE)
            .map_err(|e| format!("write .gitignore failed: {e}"))?;
    }

    // Stage + initial commit. `--allow-empty` so a vault that only
    // had a .gitignore (or an entirely empty vault) still produces
    // a base commit. The base commit is what `refs/heads/last-reviewed`
    // initially points at — without it, the "since you last looked"
    // view would be undefined on a brand-new vault.
    run_git(&vault_path, &["add", "-A"]).await?;
    run_git(
        &vault_path,
        &[
            "commit",
            "--allow-empty",
            "-m",
            "initial commit",
        ],
    )
    .await?;

    // Plant `last-reviewed` at the initial commit. Subsequent commits
    // (LLM ingest, user edits) move HEAD forward; the bookmark stays
    // at this base until the user clicks "Mark all reviewed".
    run_git(&vault_path, &["update-ref", LAST_REVIEWED_REF, "HEAD"]).await?;

    // Drop the in-vault gitdir pointer so a bare `git` inside the vault finds
    // this (external) repo — lets the agent revert/inspect via plain git.
    write_vault_git_pointer(&vault_path)?;

    Ok(())
}

/// Ensure each line in `entries` appears in the vault's `.gitignore`,
/// and unstage anything currently tracked that the new rules would
/// have ignored. Idempotent: re-running on an already-migrated vault
/// is a no-op (returns false).
///
/// Used at boot to bring existing vaults in line with rule changes
/// to `DEFAULT_GITIGNORE` — new vaults pick up the rules from
/// `init_repo`, old vaults need this migration helper.
///
/// `entries` is matched line-by-line against the existing file
/// (trimmed). Each missing entry is appended; matching tracked paths
/// (e.g. `threads/foo.json` when adding `threads/`) get
/// `git rm --cached -r --ignore-unmatch` so the next commit drops
/// them from the tree. The working-tree files stay in place.
#[tauri::command]
pub async fn git_ensure_gitignore_entries(
    vault_path: String,
    entries: Vec<String>,
) -> Result<bool, String> {
    let gitignore_path = std::path::Path::new(&vault_path).join(".gitignore");
    let existing = if gitignore_path.exists() {
        std::fs::read_to_string(&gitignore_path)
            .map_err(|e| format!("read .gitignore failed: {e}"))?
    } else {
        String::new()
    };

    let existing_lines: std::collections::HashSet<String> = existing
        .lines()
        .map(|l| l.trim().to_string())
        .collect();

    let mut to_append: Vec<String> = Vec::new();
    for entry in &entries {
        let trimmed = entry.trim().to_string();
        if trimmed.is_empty() {
            continue;
        }
        if existing_lines.contains(&trimmed) {
            continue;
        }
        to_append.push(trimmed);
    }

    if to_append.is_empty() {
        return Ok(false);
    }

    let mut next = existing;
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    if !to_append.is_empty() {
        // A blank line + comment header makes the migration's origin
        // obvious when the user opens .gitignore later.
        if !next.is_empty() {
            next.push('\n');
        }
        next.push_str("# Added by Manila migration\n");
        for line in &to_append {
            next.push_str(line);
            next.push('\n');
        }
    }
    std::fs::write(&gitignore_path, next)
        .map_err(|e| format!("write .gitignore failed: {e}"))?;

    // Untrack anything that the new patterns would have ignored. We
    // ignore failures here — `git rm --cached` on a path that isn't
    // tracked exits non-zero, which is fine: --ignore-unmatch + the
    // `let _ =` together swallow it as a no-op.
    for entry in &to_append {
        let stripped = entry.trim_end_matches('/').to_string();
        if stripped.is_empty() {
            continue;
        }
        let _ = run_git(
            &vault_path,
            &[
                "rm",
                "-r",
                "--cached",
                "--ignore-unmatch",
                "--quiet",
                &stripped,
            ],
        )
        .await;
    }

    Ok(true)
}

/// Stage all changes and commit with `message`. Returns the new
/// HEAD SHA on success, or `None` when there was nothing to commit
/// (which is a normal outcome — debounced commit timers may fire
/// after the user has already saved everything).
#[tauri::command]
pub async fn git_commit(vault_path: String, message: String) -> Result<Option<String>, String> {
    // Stage first. `git add -A` picks up new + modified + deleted.
    run_git(&vault_path, &["add", "-A"]).await?;

    // Check for staged changes. `git diff --cached --quiet` exits 0
    // when nothing's staged, 1 when something is. Using exit codes
    // is cheaper than parsing `git status --porcelain`.
    let diff_check = git_command(&vault_path)
        .args(["diff", "--cached", "--quiet"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map_err(|e| format!("git diff check failed: {e}"))?;
    if diff_check.success() {
        // Nothing to commit. No-op success.
        return Ok(None);
    }

    run_git(&vault_path, &["commit", "-m", &message]).await?;

    let sha = run_git(&vault_path, &["rev-parse", "HEAD"]).await?;
    Ok(Some(sha.trim().to_string()))
}

/// Return commits from `<ref_name>..HEAD`, newest first. Each entry
/// includes the touched files so the frontend can render per-file
/// breakdowns without a second round trip.
///
/// When `ref_name` doesn't exist (fresh vault before init, or after
/// a manual deletion), returns an empty list rather than erroring —
/// the frontend's ActivityView treats "no ref" the same as "no
/// activity since last review".
#[tauri::command]
pub async fn git_log_since_ref(
    vault_path: String,
    ref_name: String,
) -> Result<Vec<CommitInfo>, String> {
    // Probe ref existence. `git rev-parse --verify <ref>` exits
    // non-zero when the ref is missing.
    let probe = git_command(&vault_path)
        .args(["rev-parse", "--verify", "--quiet", &ref_name])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map_err(|e| format!("ref probe failed: {e}"))?;
    if !probe.success() {
        return Ok(Vec::new());
    }

    // Format: a unit separator between header lines so we can split
    // unambiguously. `--name-status` appends file lines after each
    // commit header, separated by a blank line. We use `%x00` (NUL)
    // as the header field separator and `%x1e` (record separator)
    // between commits.
    let range = format!("{}..HEAD", ref_name);
    let stdout = run_git(
        &vault_path,
        &[
            "log",
            &range,
            "--pretty=format:%x1e%H%x00%ct%x00%s",
            "--name-status",
        ],
    )
    .await?;

    let mut commits: Vec<CommitInfo> = Vec::new();
    for record in stdout.split('\u{001e}') {
        let record = record.trim_matches('\n');
        if record.is_empty() {
            continue;
        }
        // First line: <sha>\0<timestamp>\0<subject>
        // Then blank line, then `STATUS\tPATH` lines.
        let mut lines = record.split('\n');
        let header = lines.next().unwrap_or("");
        let mut parts = header.splitn(3, '\u{0000}');
        let sha = parts.next().unwrap_or("").to_string();
        let ts_str = parts.next().unwrap_or("0");
        let subject = parts.next().unwrap_or("").to_string();
        if sha.is_empty() {
            continue;
        }
        let timestamp: i64 = ts_str.parse().unwrap_or(0);

        let mut files: Vec<FileChange> = Vec::new();
        for line in lines {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            // Status<TAB>path  (rename has Status<TAB>old<TAB>new — we
            // take the destination path for display).
            let mut cols = line.split('\t');
            let status_raw = cols.next().unwrap_or("");
            // Strip any rename-score suffix from R100 / C75 etc.
            let status: String = status_raw.chars().take(1).collect();
            let path_first = cols.next().unwrap_or("");
            let path_last = cols.next().unwrap_or(path_first);
            let path = if path_last.is_empty() {
                path_first.to_string()
            } else {
                path_last.to_string()
            };
            if path.is_empty() {
                continue;
            }
            files.push(FileChange { status, path });
        }

        commits.push(CommitInfo {
            sha,
            subject,
            timestamp,
            files,
        });
    }

    Ok(commits)
}

/// Move `ref_name` to point at `target` (a SHA or another ref). Used
/// by the "Mark all reviewed" button to advance `refs/heads/last-reviewed`
/// to HEAD. Idempotent; safe to call when already there.
#[tauri::command]
pub async fn git_advance_ref(
    vault_path: String,
    ref_name: String,
    target: String,
) -> Result<(), String> {
    run_git(&vault_path, &["update-ref", &ref_name, &target]).await?;
    Ok(())
}

/// Create a new commit that reverses `sha`. Equivalent to `git
/// revert --no-edit <sha>`. Returns the new HEAD after the revert.
///
/// `--no-edit` skips the editor and uses git's default revert
/// message ("Revert \"<subject>\""). Merge commits aren't supported
/// here because the vault is single-author / linear; if a merge
/// arrives (Sub 0.4 remote sync), we'll handle it separately.
///
/// **Conflict handling**: reverting a non-tip commit can produce a
/// merge conflict (e.g. a later commit modified the same lines the
/// revert needs to touch). git leaves the working tree in a
/// `revert in progress` state where every subsequent `git revert`,
/// `git cherry-pick`, etc. fails with "Reverting is not possible
/// because you have unmerged files." The user can't escape without
/// `git revert --abort` from the CLI — not acceptable for an app
/// where most users don't open a terminal.
///
/// We catch the failure, run `git revert --abort` to clear the
/// merge state, and bubble the original error up. The next revert
/// attempt then proceeds against a clean tree.
#[tauri::command]
pub async fn git_revert(vault_path: String, sha: String) -> Result<String, String> {
    match run_git(&vault_path, &["revert", "--no-edit", &sha]).await {
        Ok(_) => {
            let head = run_git(&vault_path, &["rev-parse", "HEAD"]).await?;
            Ok(head.trim().to_string())
        }
        Err(revert_err) => {
            // Best-effort cleanup — if abort itself fails (e.g.
            // there was no merge state because the revert failed
            // for a non-conflict reason), we still surface the
            // original revert error. Silently swallowing the abort
            // error keeps the user-facing message focused on what
            // they care about: why the revert didn't work.
            let _ = run_git(&vault_path, &["revert", "--abort"]).await;
            Err(revert_err)
        }
    }
}

/// Return current HEAD SHA. Used after init to display the "vault
/// at <sha>" affordance and for diagnostics.
#[tauri::command]
pub async fn git_current_head(vault_path: String) -> Result<String, String> {
    let head = run_git(&vault_path, &["rev-parse", "HEAD"]).await?;
    Ok(head.trim().to_string())
}

/// Committer timestamp of HEAD as Unix seconds. The daily-snapshot
/// safety net in BootGate uses this to decide whether to fire a
/// "you haven't committed in 24 h" automatic snapshot. Errors when
/// HEAD is unborn (no commits yet) — caller treats that as "skip".
#[tauri::command]
pub async fn git_head_timestamp(vault_path: String) -> Result<i64, String> {
    let stdout = run_git(&vault_path, &["log", "-1", "--format=%ct", "HEAD"]).await?;
    stdout
        .trim()
        .parse::<i64>()
        .map_err(|e| format!("parse HEAD timestamp failed: {e}"))
}

/// Returns true when the working tree has uncommitted changes.
/// Cheap: shells out to `git status --porcelain` and checks if the
/// output is empty. Frontend uses this for the status badge "dirty"
/// state and to decide whether `git_commit` would actually do work.
#[tauri::command]
pub async fn git_is_dirty(vault_path: String) -> Result<bool, String> {
    let stdout = run_git(&vault_path, &["status", "--porcelain"]).await?;
    Ok(!stdout.trim().is_empty())
}

/// Return the full detail for a commit: subject, body, timestamp,
/// and per-file added / removed content lines. The frontend's
/// Review-panel detail view consumes this so users can see WHAT
/// changed (added lines) and WHY (commit body) without leaving the
/// panel.
///
/// We use two `git` invocations rather than one combined parse:
///   1. `git show -s --format=%H%n%ct%n%s%n%B%n@@END@@` —
///      header (sha, time, subject, body, terminator). Predictable
///      single-record parse with no diff to wade through.
///   2. `git show <sha> --no-color --pretty=format: --unified=0 --no-renames`
///      → per-file unified diff. We only need the +/- content lines,
///      not the hunk headers, so unified=0 collapses surrounding
///      context to nothing.
#[tauri::command]
pub async fn git_show(vault_path: String, sha: String) -> Result<CommitDetail, String> {
    // Header: SHA, committer-time, subject, body separated by NUL
    // bytes. Body itself can contain newlines; the trailing sentinel
    // line lets us bound it without escaping.
    const SENTINEL: &str = "@@END_OF_BODY@@";
    let header_format = format!("%H%x00%ct%x00%s%x00%B%n{SENTINEL}");
    let header = run_git(
        &vault_path,
        &["show", "-s", &format!("--format={header_format}"), &sha],
    )
    .await?;

    // Strip the sentinel + the line break before it. `git show` adds
    // a single trailing newline after %n; trim_end keeps the body
    // intact while removing that.
    let header = header
        .trim_end()
        .trim_end_matches(SENTINEL)
        .trim_end_matches('\n');
    let mut parts = header.splitn(4, '\u{0000}');
    let sha_out = parts.next().unwrap_or("").to_string();
    let ts_str = parts.next().unwrap_or("0");
    let subject = parts.next().unwrap_or("").to_string();
    let body_raw = parts.next().unwrap_or("");
    let timestamp: i64 = ts_str.parse().unwrap_or(0);
    // %B yields `<subject>\n\n<body>` so strip the leading subject +
    // blank line if present; otherwise the body equals the subject
    // and we leave it empty.
    let body = body_raw
        .strip_prefix(&subject)
        .map(|rest| rest.trim_start_matches('\n').to_string())
        .unwrap_or_else(|| body_raw.to_string());

    // Diff: --unified=0 keeps only changed lines (no surrounding
    // context). --no-color so we don't have to strip ANSI escapes.
    let diff_text = run_git(
        &vault_path,
        &[
            "show",
            &sha,
            "--no-color",
            "--pretty=format:",
            "--unified=0",
            "--no-renames",
        ],
    )
    .await?;

    let files = parse_unified_diff(&diff_text);

    Ok(CommitDetail {
        sha: sha_out,
        subject,
        body,
        timestamp,
        files,
    })
}

/// Walk a unified diff and produce one FileDiff per touched file.
/// Skips index lines, `+++` / `---` markers, and diff metadata — only
/// the lines that start with a single `+` or `-` are recorded. Hunk
/// headers (`@@ -A,B +C,D @@`) are parsed for line-number cursors but
/// not emitted as DiffLine entries.
fn parse_unified_diff(diff_text: &str) -> Vec<FileDiff> {
    let mut files: Vec<FileDiff> = Vec::new();
    let mut current: Option<FileDiff> = None;
    // Running line cursors, reset on every hunk header. `new_cursor`
    // points at the next `+` line's new-side number; `old_cursor` at
    // the next `-` line's old-side number. 0 means "no hunk seen yet"
    // and shouldn't normally occur because `+`/`-` lines only appear
    // inside hunks.
    let mut new_cursor: u32 = 0;
    let mut old_cursor: u32 = 0;

    for line in diff_text.lines() {
        if let Some(rest) = line.strip_prefix("diff --git ") {
            // Push the in-progress file before starting a new one.
            if let Some(f) = current.take() {
                files.push(f);
            }
            // `diff --git a/<path> b/<path>` — extract the b-side
            // path. Quoted paths (with spaces or Unicode) come back
            // with surrounding quotes; we accept either shape.
            let path = rest
                .rsplit_once(" b/")
                .map(|(_, p)| p.trim_matches('"').to_string())
                .unwrap_or_else(|| rest.to_string());
            current = Some(FileDiff {
                path,
                status: String::from("M"),
                lines: Vec::new(),
            });
            new_cursor = 0;
            old_cursor = 0;
            continue;
        }
        // File-mode hints: `new file mode 100644` ↦ status A,
        // `deleted file mode ...` ↦ status D. Defaults to M.
        if line == "new file mode 100644" || line.starts_with("new file mode ") {
            if let Some(f) = current.as_mut() {
                f.status = String::from("A");
            }
            continue;
        }
        if line == "deleted file mode 100644" || line.starts_with("deleted file mode ") {
            if let Some(f) = current.as_mut() {
                f.status = String::from("D");
            }
            continue;
        }
        // Hunk header: capture the starting line numbers so subsequent
        // `+`/`-` lines can be attributed back to file positions.
        if line.starts_with("@@") {
            if let Some((old_start, new_start)) = parse_hunk_header(line) {
                old_cursor = old_start;
                new_cursor = new_start;
            }
            continue;
        }
        // Skip every other diff metadata line.
        if line.starts_with("index ")
            || line.starts_with("--- ")
            || line.starts_with("+++ ")
            || line.starts_with("Binary files ")
            || line.starts_with("\\ No newline")
        {
            continue;
        }
        let Some(f) = current.as_mut() else { continue };
        if let Some(rest) = line.strip_prefix('+') {
            f.lines.push(DiffLine {
                kind: "add",
                text: rest.to_string(),
                line_num: new_cursor,
            });
            new_cursor = new_cursor.saturating_add(1);
        } else if let Some(rest) = line.strip_prefix('-') {
            f.lines.push(DiffLine {
                kind: "remove",
                text: rest.to_string(),
                line_num: old_cursor,
            });
            old_cursor = old_cursor.saturating_add(1);
        }
        // Context lines (no prefix) shouldn't appear with
        // --unified=0, so silently ignored.
    }

    if let Some(f) = current.take() {
        files.push(f);
    }
    files
}

/// Parse the starting line numbers out of a unified-diff hunk header.
/// Format: `@@ -<old_start>[,<old_count>] +<new_start>[,<new_count>] @@ [context]`.
/// Returns `(old_start, new_start)`. Both are 1-based. When `<count>`
/// is 0 (pure-insertion or pure-deletion hunks), git emits `<start>`
/// as "the line before the hunk would appear" — we still treat that
/// as the cursor's starting value since no `+`/`-` will actually use
/// it: a 0-count side simply produces no diff lines on that side.
fn parse_hunk_header(line: &str) -> Option<(u32, u32)> {
    // Strip leading `@@ ` and the trailing ` @@ ...` so we're left
    // with the `-A[,B] +C[,D]` core.
    let after_first = line.strip_prefix("@@ ")?;
    let (range, _rest) = after_first.split_once(" @@")?;
    let (old_part, new_part) = range.split_once(' ')?;
    let old_start = parse_signed_range(old_part, '-')?;
    let new_start = parse_signed_range(new_part, '+')?;
    Some((old_start, new_start))
}

/// Parse one side of a hunk range ("-12,3" or "+45") into its
/// starting line number. The `sign` argument is the prefix character
/// expected on that side (`-` for old, `+` for new).
fn parse_signed_range(part: &str, sign: char) -> Option<u32> {
    let body = part.strip_prefix(sign)?;
    let start_str = body.split(',').next()?;
    start_str.parse::<u32>().ok()
}

#[cfg(test)]
mod boot_cost {
    /// What `git_init` actually costs on the path the app takes at every boot.
    ///
    /// The audit calls this "blocks on every boot" and lists the unbounded
    /// `copy_dir_recursive` first. But boot hits the fast path — `relocate_git_dir`
    /// early-returns, `external.exists()` is true, and we write the gitdir pointer
    /// and return. This times exactly that against the real vault and the real
    /// app-data dir, so the claim becomes a number instead of a reading of the code.
    ///
    /// Ignored by default: it needs this machine's vault. Run with
    /// `cargo test --lib boot_cost -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn measure_git_init_fast_path() {
        let home = std::env::var("HOME").unwrap();
        let vault = format!("{home}/Writer");
        let appdata =
            std::path::PathBuf::from(&home).join("Library/Application Support/com.minkyojung.octave");
        assert!(
            std::path::Path::new(&vault).is_dir() && appdata.is_dir(),
            "needs this machine's real vault + app-data"
        );
        crate::appdata::init(appdata);

        let mut times = Vec::new();
        for _ in 0..10 {
            let v = vault.clone();
            let t0 = std::time::Instant::now();
            tauri::async_runtime::block_on(super::git_init(v)).unwrap();
            times.push(t0.elapsed().as_secs_f64() * 1000.0);
        }
        println!(
            "git_init fast path, in call order (ms): {}",
            times
                .iter()
                .map(|t| format!("{t:.2}"))
                .collect::<Vec<_>>()
                .join(", ")
        );
    }
}
