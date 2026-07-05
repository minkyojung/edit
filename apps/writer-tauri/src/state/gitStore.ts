// Git status + commit orchestration for the vault.
//
// Two roles:
//
//   1. Commit triggers — `commitChangesNow` (synchronous, for explicit
//      callers like LLM ingest end-of-action) and `commitImmediate`
//      (the manual "Save snapshot" button in the editor header).
//      There is no time-based auto-commit; commits only happen on
//      explicit user / system action. A separate daily safety-net
//      runs at boot from BootGate.
//
//   2. Status surfacing — `status` field drives the GitStatusBadge.
//      Transitions: idle → committing → idle, or idle → error.
//
// Activity-since-last-review state (commits, lastReviewedSha) lives
// in this store too so the ActivityView can subscribe to a single
// slice and re-render when a new commit lands.
//
// We intentionally don't persist anything here — the truth lives in
// `.git/`. On reload the store re-derives by querying git. That
// keeps git and our memory model from diverging.

import { create } from 'zustand'
import {
  gitCommit,
  gitLogSinceRef,
  gitRevert,
  gitCurrentHead,
  gitShow,
  type CommitInfo,
  type CommitDetail,
} from '@/lib/git'
import { flushDirty } from '@/lib/docFileSync'
import { notify } from '@/lib/notify'

/** Lifecycle status of the most recent commit attempt. UI uses this
 * to decide the badge colour / icon. */
export type GitStatus = 'idle' | 'committing' | 'error'

interface GitState {
  /** Current commit lifecycle state. */
  status: GitStatus

  /** Last error message (if status === 'error'). Used by the toast
   * to surface a useful "see console for details" alternative. */
  lastError: string | null

  /** Current HEAD SHA. Updated after every commit / revert / refresh.
   * Null before the first refresh (boot). */
  headSha: string | null

  /** Commits in `last-reviewed..HEAD` order, newest first. Refreshed
   * after every commit and on explicit `refreshActivity()` calls.
   * The ActivityView subscribes to this slice. */
  activity: CommitInfo[]

  /** Paths touched since the last commit. Cleared when a commit lands.
   * Used to (a) decide whether the manual commit button is enabled
   * and (b) assemble the auto-generated commit message. */
  dirtyPaths: Set<string>

  /** SHAs of commits the user has expanded inline in the Review
   * panel. Multiple cards can be open at once. Toggling a sha here
   * triggers a lazy fetch into `commitDetails` if it's not already
   * cached. */
  expandedShas: Set<string>

  /** Memoised commit-detail responses keyed by sha. We never
   * invalidate them because commit content is immutable — a sha is
   * a content hash. Cleared only on app reload. */
  commitDetails: Record<string, CommitDetail>

  /** SHAs currently fetching git_show. Lets each expanded card show
   * its own loader while siblings render their already-cached
   * detail. */
  loadingShas: Set<string>

  /** SHAs the user has clicked "Reviewed" on. The gutter marker
   * hides these even though they're still in `activity`. Populated
   * by `dismissSha` (U.3) and cleared by `markAllReviewed`. */
  dismissedShas: Set<string>

  /** Explicit "commit now with this message". Used by LLM ingest and
   * any other code path that has a meaningful message ready. */
  commitChangesNow: (message: string) => Promise<void>

  /** Record that a path was just written. Adds it to `dirtyPaths` so
   * the manual commit button knows there's something to commit. No
   * timers, no automatic commit — see commitImmediate for that. */
  noteActivity: (path: string) => void

  /** Commit whatever is in `dirtyPaths` now with an auto-generated
   * message. The "Save snapshot" button in the editor header calls
   * this. No-op when `dirtyPaths` is already empty. */
  commitImmediate: () => Promise<void>

  /** Reload the activity feed (commits since last-reviewed) and
   * headSha. Called after every commit / revert and by the review
   * panel when the user opens it. */
  refreshActivity: () => Promise<void>

  /** Create a revert commit for `sha`. The vault watcher picks up
   * the file changes and reloads the affected pages, so the
   * editor reflects the rollback without any explicit refresh
   * here. */
  revertCommit: (sha: string) => Promise<void>

  /** Toggle the inline expansion of one card. First open of a
   * sha kicks off the lazy git_show fetch into `commitDetails`. */
  toggleCommitDetail: (sha: string) => Promise<void>

  /** Ensure `commitDetails[sha]` is populated, without changing the
   * expanded state. Used by the gutter marker, which needs detail
   * for every active ai-edit commit regardless of Review-panel UI.
   * No-op when the detail is already cached. */
  ensureCommitDetail: (sha: string) => Promise<void>
}

/** Build an auto-generated commit message from a set of changed
 * paths. Single-file edits get the basename; multi-file edits
 * collapse to "edit: N files".
 *
 * Exported for testing. */
export function autoCommitMessage(paths: Set<string>): string {
  if (paths.size === 0) return 'edit'
  if (paths.size === 1) {
    const only = [...paths][0]
    const base = only.split('/').pop() ?? only
    return `edit: ${base}`
  }
  return `edit: ${paths.size} files`
}

/** Vault subdirectories the user thinks of as "their content". The
 * activity feed only surfaces commits that touch at least one file
 * under one of these prefixes — so a background system write (chat
 * thread JSON, system page regeneration, etc.) doesn't pollute the
 * "Recent changes" view.
 *
 * The opposite shapes — `threads/`, `_system/` — still get committed
 * and pushed normally; we want them in history for backup and cross-
 * device sync. They just don't deserve a card the user has to scan
 * past every time they open the activity feed.
 *
 * Mixed commits (user file + system file in the same commit) count
 * as visible because the user's intent IS part of what's there. */
const USER_PATH_PREFIXES = ['daily/', 'wiki/', 'writing/'] as const

/** Decide whether a commit should appear in the user-facing activity
 * feed. The rule: at least one touched file must live under a
 * user-visible prefix. Empty-file commits (shouldn't happen in
 * practice — git refuses empty commits unless `--allow-empty`) fall
 * through to "visible" as a safety net so unknown shapes don't get
 * silently dropped.
 *
 * Exported so the future "Show system activity" toggle (when/if
 * added) can reuse the same predicate inverted. */
export function isUserVisibleCommit(commit: CommitInfo): boolean {
  if (commit.files.length === 0) return true
  return commit.files.some((f) =>
    USER_PATH_PREFIXES.some((prefix) => f.path.startsWith(prefix)),
  )
}

/** Match commits produced by the LLM-edit path (sidecar ingest, chat
 * handoff, direct edit). Subject conventions:
 *   - `ai-edit: ingest from <label> (<N> updates)`
 *   - `ai-edit: chat reply (<N> edits)`
 *   - `ai-edit: chat: <command> (<N> edits)`
 * The Review panel's `commitSource` strips the same prefix for label
 * extraction; the gutter only needs the boolean. Keep both helpers in
 * sync if the convention changes. */
export function isAiEditCommit(commit: CommitInfo): boolean {
  return commit.subject.startsWith('ai-edit:')
}

export const useGitStore = create<GitState>((set, get) => {
  // Serialize every git-mutating op (commit AND revert). Two independent
  // callers — a Keep-burst commit (applier) and an idle-organize / turn-end
  // move commit — can fire concurrently; without this their `git add -A`,
  // commit, and revert would interleave against one repo and stage each
  // other's partial writes. Each op waits for the previous to finish, whether
  // it resolved or threw.
  let gitLock: Promise<unknown> = Promise.resolve()
  function withGitLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = gitLock.then(fn, fn)
    gitLock = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  // Shared core: flush → snapshot dirtyPaths → commit. Both
  // commitChangesNow and commitImmediate funnel through here (under the git
  // lock) so status transitions and activity refresh stay in lock-step.
  async function runCommit(message: string): Promise<void> {
    // Snapshot the paths this commit covers at CALL time (before the lock
    // defers and before flushDirty), but DON'T clear them up-front: an edit
    // landing during the flush / lock-wait / gitCommit await must survive (we
    // clear only this subset on success), and a failed commit must leave the
    // dirty set intact for retry. flushDirty only writes already-dirty docs,
    // so it adds no path outside this snapshot.
    const committing = get().dirtyPaths
    return withGitLock(async () => {
      // Drain in-memory Y.Doc edits to disk FIRST so `git add -A` captures the
      // real on-disk state — callers (applier, turn-end, idle organize) don't
      // need to flush themselves. gitCommit is empty-safe (returns null with no
      // --allow-empty), so a nothing-to-commit call is a clean no-op.
      try {
        await flushDirty()
      } catch (err) {
        console.warn('[git] flushDirty before commit failed', err)
      }
      set({ status: 'committing' })

      try {
        const sha = await gitCommit(message)
        if (sha !== null) set({ headSha: sha })
        set((s) => ({
          dirtyPaths: new Set(
            [...s.dirtyPaths].filter((p) => !committing.has(p)),
          ),
          status: 'idle',
          lastError: null,
        }))
        void get().refreshActivity()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[git] commit failed', err)
        set({ status: 'error', lastError: msg })
        notify.gitCommitFailed()
      }
    })
  }

  return {
    status: 'idle',
    lastError: null,
    headSha: null,
    activity: [],
    dirtyPaths: new Set(),
    expandedShas: new Set<string>(),
    commitDetails: {},
    loadingShas: new Set<string>(),
    dismissedShas: new Set<string>(),

    commitChangesNow: async (message) => {
      await runCommit(message)
    },

    commitImmediate: async () => {
      const paths = get().dirtyPaths
      if (paths.size === 0) return
      await runCommit(autoCommitMessage(paths))
    },

    noteActivity: (path) => {
      set((s) => {
        const next = new Set(s.dirtyPaths)
        next.add(path)
        return { dirtyPaths: next }
      })
    },

    refreshActivity: async () => {
      try {
        const [commits, head] = await Promise.all([
          // `@{u}` = the branch's upstream (last pushed point). The feed
          // is "changes since the last backup"; pushing advances `@{u}`
          // and clears it. No upstream yet (before first backup) →
          // git_log_since_ref returns empty.
          gitLogSinceRef('@{u}'),
          gitCurrentHead(),
        ])
        // Filter to commits the user cares about. System-only commits
        // (threads/, _system/) still live in git history — we just
        // don't surface them as cards. See isUserVisibleCommit.
        set({ activity: commits.filter(isUserVisibleCommit), headSha: head })
      } catch (err) {
        console.warn('[git] refreshActivity failed', err)
      }
    },

    revertCommit: async (sha) => {
      return withGitLock(async () => {
      set({ status: 'committing' })
      try {
        // `git revert` refuses to run with a dirty working tree (it
        // would clobber uncommitted edits). Two pre-revert steps
        // guarantee clean state:
        //
        //   1. flushDirty() — drain any in-memory Y.Doc edits to disk.
        //      Without this, paragraphs the user typed in the last
        //      ~2 s could still be sitting in Y.Doc.
        //   2. Synchronous commit of whatever dirtyPaths exist. Now
        //      `git status --porcelain` is empty and `git revert`
        //      proceeds without complaint.
        await flushDirty()
        const pendingPaths = get().dirtyPaths
        if (pendingPaths.size > 0) {
          const message = autoCommitMessage(pendingPaths)
          // Don't clear up-front — if this pre-revert commit throws, the
          // catch below would otherwise lose the dirty set with the
          // changes still uncommitted on disk. Clear the committed paths
          // only after the commit lands.
          await gitCommit(message)
          set((s) => ({
            dirtyPaths: new Set(
              [...s.dirtyPaths].filter((p) => !pendingPaths.has(p)),
            ),
          }))
        }

        const newHead = await gitRevert(sha)
        set({ headSha: newHead, status: 'idle' })
        void get().refreshActivity()
        notify.gitRevertSucceeded()
      } catch (err) {
        console.error('[git] revert failed', err)
        const msg = err instanceof Error ? err.message : String(err)
        set({ status: 'error', lastError: msg })
        notify.gitRevertFailed()
      }
      })
    },
    toggleCommitDetail: async (sha) => {
      const wasOpen = get().expandedShas.has(sha)
      set((s) => {
        const next = new Set(s.expandedShas)
        if (wasOpen) next.delete(sha)
        else next.add(sha)
        return { expandedShas: next }
      })
      // Collapse — nothing else to do. The cached detail stays
      // around so re-opening the same card is instant.
      if (wasOpen) return
      // Open path delegates the actual fetch to ensureCommitDetail
      // so the gutter marker and the Review panel share one fetch
      // path and one loading-state shape.
      await get().ensureCommitDetail(sha)
    },

    ensureCommitDetail: async (sha) => {
      // Cache hit — nothing to fetch. Commit content is immutable
      // (sha == content hash) so a cached detail is forever valid.
      if (get().commitDetails[sha]) return
      // Already fetching from another caller — let it complete.
      // Two parallel `gitShow` calls would race-write commitDetails
      // (last writer wins on the same data) and double the loading
      // flicker for no benefit.
      if (get().loadingShas.has(sha)) return
      set((s) => {
        const next = new Set(s.loadingShas)
        next.add(sha)
        return { loadingShas: next }
      })
      try {
        const detail = await gitShow(sha)
        if (detail) {
          set((s) => ({
            commitDetails: { ...s.commitDetails, [sha]: detail },
          }))
        }
      } catch (err) {
        console.warn('[git] gitShow failed for', sha, err)
      } finally {
        set((s) => {
          const next = new Set(s.loadingShas)
          next.delete(sha)
          return { loadingShas: next }
        })
      }
    },
  }
})
