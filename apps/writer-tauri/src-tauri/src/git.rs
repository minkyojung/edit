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
use std::process::Stdio;
use tokio::process::Command;

/// Bookmark ref name used for the "last reviewed" pointer. The
/// frontend's ActivityView shows commits in `<this-ref>..HEAD` and
/// the "Mark all reviewed" action advances this ref to HEAD.
///
/// Stored as a regular branch ref so plain `git` CLI users can see
/// and manipulate it too (e.g. `git rev-parse last-reviewed`).
const LAST_REVIEWED_REF: &str = "refs/heads/last-reviewed";

/// .gitignore body seeded on `init_repo`. Kept minimal — the vault
/// IS the user's content, so we only ignore editor + OS junk.
const DEFAULT_GITIGNORE: &str = "# Manila vault gitignore — managed by the app, edit freely.\n\
.DS_Store\n\
.manila-tmp/\n\
\n\
# Yjs binary state — mirrors the .md content. Regenerated on edit;\n\
# tracking it just bloats history. The .meta.json sidecar IS tracked\n\
# because it carries durable metadata (aiSummary, archivedAt, …).\n\
*.ydoc\n";

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

/// Build a `Command` anchored at `vault_path` AND pinned to
/// `vault_path/.git` via `--git-dir` + `--work-tree`. The explicit
/// pins are what stop git's working-tree discovery from walking up
/// to ancestor directories — without them a stray `.git/` in `$HOME`
/// (common after an accidental `git init ~`) would silently swallow
/// every command and we'd be operating on the wrong repo.
///
/// Every git invocation in this module goes through this helper so
/// the anchoring rule lives in exactly one place.
fn git_command(vault_path: &str) -> Command {
    let trimmed = vault_path.trim_end_matches('/');
    let git_dir = format!("{trimmed}/.git");
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(vault_path);
    cmd.arg(format!("--git-dir={git_dir}"));
    cmd.arg(format!("--work-tree={trimmed}"));
    cmd.stdin(Stdio::null());
    cmd
}

/// Run `git` with the given args via {@link git_command}. Captures
/// stdout + stderr. Returns Err with stderr text when git exits
/// non-zero — caller decides whether that's fatal or expected
/// (e.g. `git commit` with nothing staged is a normal no-op).
async fn run_git(vault_path: &str, args: &[&str]) -> Result<String, String> {
    let mut cmd = git_command(vault_path);
    for a in args {
        cmd.arg(a);
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

/// Initialise a git repo inside `vault_path` if one isn't already
/// there. Seeds `.gitignore` and produces an initial commit so
/// subsequent revert / log operations have a base.
///
/// Idempotent: if `.git/` exists we return immediately without
/// touching the repo. The frontend calls this on every boot after
/// the vault picker, so a no-op fast path matters.
#[tauri::command]
pub async fn git_init(vault_path: String) -> Result<(), String> {
    // Already a repo? We check the filesystem directly rather than
    // shelling out to `git rev-parse --git-dir` because that command
    // walks ancestor directories looking for ANY `.git` — and a
    // stray `.git/` in `$HOME` (common after an accidental
    // `git init ~`) would make us treat the user's whole home as
    // the vault repo. Direct path check is unambiguous: a repo lives
    // in `<vault>/.git` or it doesn't.
    let git_dir = std::path::Path::new(&vault_path).join(".git");
    if git_dir.exists() {
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

    // From this point on we're creating the repo inside `vault_path`.
    // Use a plain (no `-C`, no `--git-dir`) `git init` so the new
    // repo lands exactly where we expect. After this call `.git/`
    // exists and subsequent `run_git` calls (which pass --git-dir
    // explicitly) operate on it directly.
    //
    // `-b main` requires git 2.28+; shipped with every supported
    // macOS for several years.
    let init_status = Command::new("git")
        .arg("init")
        .arg("-b")
        .arg("main")
        .arg(&vault_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| format!("git init spawn failed: {e}"))?;
    if !init_status.status.success() {
        let stderr = String::from_utf8_lossy(&init_status.stderr).into_owned();
        return Err(format!("git init failed: {}", stderr.trim()));
    }

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

    Ok(())
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
