//! App-data paths for per-device machinery that must NOT live inside the
//! synced vault folder — the git history (`.git`) and the GitHub-activity
//! cache (`events.db`). Keeping them in the vault would corrupt across devices
//! when the vault is replicated by a file-sync (iCloud/Syncthing/Dropbox); the
//! vault must stay a clean folder of user files.
//!
//! The base directory is resolved ONCE at startup (lib.rs `setup()`) and held
//! in a process global, so the rest of the app reads stable paths without
//! threading `AppHandle` through every function. All git/events calls happen
//! after `setup()`, so the base is always set by the time these run.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

static BASE: OnceLock<PathBuf> = OnceLock::new();

/// Set the app-data base once at startup. Idempotent (later calls are no-ops).
/// Creates the directory so callers can write into it immediately.
pub fn init(base: PathBuf) {
    let _ = std::fs::create_dir_all(&base);
    let _ = BASE.set(base);
}

fn base() -> &'static Path {
    BASE.get()
        .expect("appdata::init must run in setup() before any path lookup")
}

/// Per-device GitHub-activity cache DB (sibling of secure storage, OUTSIDE the
/// synced vault). Derived from GitHub — rebuilt on demand, never synced.
pub fn events_db_path() -> PathBuf {
    base().join("events.db")
}

/// External git directory for `vault_path`, keyed by a stable hash of its
/// canonical path (unique per vault, stable across restarts/updates). Keyed on
/// the PATH — not the manifest vault_id — because `git_init` runs before any
/// backup creates the manifest. The parent (`git-repos/`) is created on demand.
pub fn vault_git_dir(vault_path: &str) -> PathBuf {
    let dir = base().join("git-repos");
    let _ = std::fs::create_dir_all(&dir);
    dir.join(vault_key(vault_path))
}

fn vault_key(vault_path: &str) -> String {
    use sha2::{Digest, Sha256};
    // Canonicalize so trailing slashes / symlinks don't shift the key; fall
    // back to the trimmed raw path when the vault doesn't exist yet (rare).
    let canonical = std::fs::canonicalize(vault_path)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| vault_path.trim_end_matches('/').to_string());
    let digest = Sha256::digest(canonical.as_bytes());
    // 8 bytes → 16 hex chars: plenty to avoid collisions across a user's vaults.
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}
