// Thin invoke wrappers for the rust git commands in
// `src-tauri/src/git.rs`. Every call resolves the active vault path
// once at the wrapper layer so call sites stay free of the
// "settings → vault → invoke" boilerplate.
//
// All wrappers return null / [] gracefully when there's no active
// vault — gitStore actions check for that case so they're safe to
// call before onboarding completes. The rust side itself never
// guards against missing vault (it'd fail at `git -C`), so the
// front-of-house check belongs here.

import { invoke } from '@tauri-apps/api/core'
import { getActiveVaultPath } from '@/state/settingsStore'

/** Reference name used as the "last reviewed" bookmark. Mirrors the
 * constant in `src-tauri/src/git.rs::LAST_REVIEWED_REF`. Exposed
 * here so the gitStore can pass it to `git_log_since_ref` and
 * `git_advance_ref` without re-hardcoding. */
export const LAST_REVIEWED_REF = 'refs/heads/last-reviewed'

/** One commit returned by `git_log_since_ref`. Shape matches the
 * rust `CommitInfo` struct (camelCase via serde rename). */
export interface CommitInfo {
  sha: string
  subject: string
  /** Unix seconds. Frontend converts to relative time at render. */
  timestamp: number
  files: FileChange[]
}

export interface FileChange {
  /** `M` / `A` / `D` / `R` / `C` / `T`. */
  status: string
  path: string
}

/** Initialise the vault as a git repo if it isn't one already.
 * Idempotent — the rust side fast-paths when `.git` already exists.
 * Called by BootGate after the vault picker. */
export async function gitInit(): Promise<void> {
  const vault = getActiveVaultPath()
  if (!vault) return
  await invoke<void>('git_init', { vaultPath: vault })
}

/** Append `entries` to the vault's `.gitignore` if missing, and
 * `git rm --cached` any paths the new rules would have ignored.
 * Returns true when the file changed. Boot-time migration helper —
 * brings vaults that pre-date a `DEFAULT_GITIGNORE` change in line
 * with the current rules without losing the user's own additions. */
export async function gitEnsureGitignoreEntries(
  entries: string[],
): Promise<boolean> {
  const vault = getActiveVaultPath()
  if (!vault) return false
  return invoke<boolean>('git_ensure_gitignore_entries', {
    vaultPath: vault,
    entries,
  })
}

/** Stage everything and commit with `message`. Returns the new HEAD
 * SHA, or null when there was nothing to commit (debounce-fire-after-
 * save scenarios). Errors throw — caller decides whether to toast. */
export async function gitCommit(message: string): Promise<string | null> {
  const vault = getActiveVaultPath()
  if (!vault) return null
  return invoke<string | null>('git_commit', {
    vaultPath: vault,
    message,
  })
}

/** Get commits from `<ref>..HEAD`. Empty array when the ref doesn't
 * exist yet (fresh vault, no commits, etc.). */
export async function gitLogSinceRef(
  refName: string = LAST_REVIEWED_REF,
): Promise<CommitInfo[]> {
  const vault = getActiveVaultPath()
  if (!vault) return []
  return invoke<CommitInfo[]>('git_log_since_ref', {
    vaultPath: vault,
    refName,
  })
}

/** Move a ref to point at `target` (SHA or another ref). The "Mark
 * all reviewed" action calls this with `refs/heads/last-reviewed`
 * and `HEAD`. */
export async function gitAdvanceRef(
  refName: string,
  target: string = 'HEAD',
): Promise<void> {
  const vault = getActiveVaultPath()
  if (!vault) return
  await invoke<void>('git_advance_ref', {
    vaultPath: vault,
    refName,
    target,
  })
}

/** Create a revert commit that reverses `sha`. Returns the new HEAD.
 * The vault watcher picks up the file changes and reloads the
 * affected pages automatically. */
export async function gitRevert(sha: string): Promise<string> {
  const vault = getActiveVaultPath()
  if (!vault) throw new Error('no active vault')
  return invoke<string>('git_revert', {
    vaultPath: vault,
    sha,
  })
}

/** Current HEAD SHA. Used by gitStore to track HEAD movement for
 * the activity-since-last-review counter. */
export async function gitCurrentHead(): Promise<string | null> {
  const vault = getActiveVaultPath()
  if (!vault) return null
  return invoke<string>('git_current_head', { vaultPath: vault })
}

/** Committer timestamp of HEAD as Unix seconds. Returns null when
 * there's no active vault or HEAD doesn't exist yet (fresh vault
 * before init). BootGate uses this to fire a daily safety-net
 * snapshot when the last commit is older than 24 h. */
export async function gitHeadTimestamp(): Promise<number | null> {
  const vault = getActiveVaultPath()
  if (!vault) return null
  try {
    return await invoke<number>('git_head_timestamp', { vaultPath: vault })
  } catch {
    return null
  }
}

/** True when the working tree has uncommitted changes. */
export async function gitIsDirty(): Promise<boolean> {
  const vault = getActiveVaultPath()
  if (!vault) return false
  return invoke<boolean>('git_is_dirty', { vaultPath: vault })
}

/** Per-file diff inside a commit. `lines` carries change lines in
 * their on-disk order (so a modify hunk reads `-old / +new` naturally
 * for an inline git-diff-style render). Status mirrors the FileChange
 * convention (`M` / `A` / `D` / `R` / `C` / `T`). */
export interface FileDiff {
  path: string
  status: string
  lines: DiffLine[]
}

export interface DiffLine {
  /** `"add"` for `+` lines, `"remove"` for `-` lines, `"context"` for
   * unchanged surrounding lines. Git diffs here request `--unified=0`
   * so they never emit `"context"`; the pending-change diff
   * (computePendingDiffLines) does, to show document context. */
  kind: 'add' | 'remove' | 'context'
  /** Line text without the `+` / `-` prefix. */
  text: string
  /** 1-based line number from the unified-diff hunk header. For
   * `add` lines this is the new-side line; for `remove` lines it's
   * the old-side line. `0` means the source hunk header couldn't be
   * parsed — defensive default only. */
  lineNum: number
}

/** Full commit metadata for the Review-panel detail view. */
export interface CommitDetail {
  sha: string
  subject: string
  /** Everything after the subject + blank line. Empty when the
   * commit has no body. */
  body: string
  timestamp: number
  files: FileDiff[]
}

/** Fetch the full detail (body + per-file added/removed) for one
 * commit. Called lazily by the Review panel when the user opens a
 * card's detail view — keeping it lazy means the list view stays
 * cheap regardless of how many commits are unreviewed. */
export async function gitShow(sha: string): Promise<CommitDetail | null> {
  const vault = getActiveVaultPath()
  if (!vault) return null
  return invoke<CommitDetail>('git_show', {
    vaultPath: vault,
    sha,
  })
}
