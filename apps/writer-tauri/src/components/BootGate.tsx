// Blocks the app UI until docsStore.bootstrap() finishes.
//
// What bootstrap() does, and why we wait for it before any UI
// renders:
//
//   1. Migrate the legacy single-slug localStorage entry into a
//      catalog-shaped daily so existing content survives the
//      multi-doc rewrite.
//   2. Ensure today's daily exists in the catalog (creating it if
//      missing).
//   3. Wire the active slug + open its collab handle.
//
// Until those land, knownDocs is empty or half-populated and the
// sidebar shows a stale shape — a user clicking "New Note" mid-
// boot could race the migration and create a doc the legacy
// adopter then duplicates. The gate sidesteps the race by simply
// not rendering the action surface until bootstrapping flips.
//
// Background backfill (the current week's dailies, future schema
// migrations that aren't blocking) deliberately fires AFTER the
// flag flips, so the user sees the app open as soon as their
// today-anchor is ready — the rest streams in.
//
import { useEffect, useState } from 'react'
import { Spinner } from '@/components/ui/spinner'
import { useDocsStore } from '@/state/docsStore'
import { useThreadsStore } from '@/state/threadsStore'
import { useGitStore } from '@/state/gitStore'
import { getActiveVaultPath } from '@/state/settingsStore'
import { VaultLauncher } from '@/components/VaultLauncher'
import {
  gitInit,
  gitHeadTimestamp,
  gitEnsureGitignoreEntries,
} from '@/lib/git'
import { remove } from '@tauri-apps/plugin-fs'
import { join } from '@tauri-apps/api/path'
import { cleanupYdocV2 } from '@/lib/cleanupYdocV2'
import { seedClaudeMd } from '@/lib/seedClaudeMd'
import { syncGitHubActivity } from '@/lib/githubSync'
import { pullVault } from '@/lib/vaultRestore'

/** Daily safety net: if HEAD is older than this, BootGate fires a
 * silent "daily snapshot" commit on app open so a passive user who
 * never clicks the manual button still has at most one day's worth
 * of work in a single uncommitted blob. */
const DAILY_SNAPSHOT_MS = 24 * 60 * 60 * 1000

const LOADER_DELAY_MS = 400 // keep spinner flashes off fast boots

interface Props {
  children: React.ReactNode
}

export function BootGate({ children }: Props) {
  const bootstrapping = useDocsStore((s) => s.bootstrapping)
  const bootstrap = useDocsStore((s) => s.bootstrap)
  const [showLoader, setShowLoader] = useState(false)
  // Vault selection is now a first-run launcher (VaultLauncher), not a silent
  // OS dialog — so the user can choose "restore from GitHub" BEFORE the boot
  // sequence fills an empty folder (the only point restore can run). The boot
  // effect below waits until a vault is in place.
  const [hasVault, setHasVault] = useState(() => !!getActiveVaultPath())

  // Fire bootstrap once on mount. The store's bootstrap is idempotent
  // (it short-circuits when the catalog already has today's daily),
  // but React's Strict Mode would still double-call this useEffect —
  // hence the idempotency on the store side, not a guard here.
  //
  // A vault must be selected before bootstrap so every doc it touches
  // (today's daily + system pages) can reach disk. VaultLauncher owns that
  // choice now — a local folder, or restore-from-GitHub (which MUST run before
  // anything fills the folder). This effect waits until a vault is in place.
  useEffect(() => {
    if (!hasVault) return
    const init = async () => {
      // Initialise git in the vault folder. Idempotent: the rust
      // side fast-paths when `.git/` already exists. We swallow
      // errors here because the editor itself shouldn't be blocked
      // on history setup — a missing `git` binary degrades to
      // "no rollback safety net" rather than "can't open the app".
      try {
        await gitInit()
      } catch (err) {
        console.warn('[boot] git init failed (history disabled)', err)
      }
      // Receive remote changes (multi-device) BEFORE bootstrap creates today's
      // daily — so a daily pushed from another device arrives first and
      // bootstrap sees it rather than minting a duplicate. Fast-forward only:
      // no-ops when not backed up, and bails (no merge commit) on divergence —
      // the conflict slice will handle that case. Awaited so the order holds;
      // pullVault never throws (it catches internally).
      await pullVault()
      // One-shot migration: pre-existing vaults predate the
      // `threads/` ignore rule in `DEFAULT_GITIGNORE`, so chat-session
      // JSON ended up tracked and bloating every commit. Sync the
      // .gitignore + untrack any matches that snuck in. Idempotent
      // after the first run — subsequent boots see the entry and
      // return false.
      try {
        await gitEnsureGitignoreEntries([
          'threads/',
          // Migration sentinel files dropped at vault root by the
          // Yjs-removal one-shots. Plain filenames (not dot-prefixed)
          // because Tauri's `fs:scope` glob silently excludes dot-
          // files; ignoring them here keeps the user's vault git
          // history clean. `writer-migration-v2.done` and
          // `writer-meta-migration-v1.done` are kept in the list so
          // vaults that already wear those markers don't suddenly
          // surface them as untracked files when the migration
          // scripts themselves are gone.
          'writer-migration-v2.done',
          'writer-meta-migration-v1.done',
          'writer-cleanup-ydoc.done',
          // GitHub-activity cache — derived/binary, must not ride along in
          // the vault backup. Untracks it from vaults where it already
          // landed (e.g. before this rule existed).
          'events.db',
          'events.db-wal',
          'events.db-shm',
        ])
      } catch (err) {
        console.warn('[boot] gitignore migration failed', err)
      }
      // Clean-boundary follow-up: the activity cache now lives in per-device
      // app-data, so delete the leftover in-vault `events.db*` (+ WAL/SHM) one
      // time. Best-effort — a missing file just means an already-clean vault.
      try {
        const vaultRoot = getActiveVaultPath()
        if (vaultRoot) {
          for (const f of ['events.db', 'events.db-wal', 'events.db-shm']) {
            await remove(await join(vaultRoot, f)).catch(() => {})
          }
        }
      } catch (err) {
        console.warn('[boot] legacy events.db cleanup failed', err)
      }
      // Phase 7 of the Yjs-removal migration: delete the leftover
      // `.ydoc` binaries now that nothing reads them. Runs BEFORE
      // bootstrap so the scan-vault catalog never sees a stray
      // `.ydoc` that Finder / git would otherwise show as untracked
      // noise. Sentinel-gated; existing vaults pay the walk cost
      // exactly once. Phase 2's `.md` back-fill ran in an earlier
      // build, so any content that was unique to `.ydoc` has
      // already been recovered.
      try {
        await cleanupYdocV2()
      } catch (err) {
        console.warn('[boot] ydoc cleanup failed', err)
      }
      // Seed `CLAUDE.md` at the vault root if the file is missing —
      // the Karpathy / Claude Code schema document the agent reads
      // every chat to know how this vault is laid out and how it
      // should behave. Idempotent by file existence (no sentinel
      // needed); a user who edits the file owns it from there on
      // and the seed never overwrites their edits.
      try {
        await seedClaudeMd()
      } catch (err) {
        console.warn('[boot] CLAUDE.md seed failed', err)
      }
      bootstrap()
      // Load chat thread metas + turns from `threads/`. Fires in
      // parallel with bootstrap because the two read disjoint paths
      // (docs read `wiki/` / `daily/` / `_system/`, threads read
      // `threads/`). hydrate is idempotent so StrictMode's double-
      // mount is safe.
      void useThreadsStore.getState().hydrate()
      // Prime the activity feed so the badge has the right count
      // the first time the user looks at it.
      void useGitStore.getState().refreshActivity()

      // Pull GitHub activity once on launch (the 30-min timer is too
      // slow for first paint). No-ops when not connected / no vault.
      void syncGitHubActivity()

      // Daily safety net. When HEAD is older than 24 h, fire a silent
      // "daily snapshot" commit so a passive user — one who never
      // clicks "Save snapshot" manually — still gets at most one day
      // of work in a single uncommitted blob. No-op when HEAD is
      // missing (fresh vault), recent (<24 h), or there's nothing
      // dirty to commit (gitCommit returns null in that case).
      void (async () => {
        const headTs = await gitHeadTimestamp()
        if (headTs === null) return
        const ageMs = Date.now() - headTs * 1000
        if (ageMs < DAILY_SNAPSHOT_MS) return
        const today = new Date().toISOString().slice(0, 10)
        await useGitStore
          .getState()
          .commitChangesNow(`daily snapshot — ${today}`)
      })()
    }
    void init()
  }, [hasVault, bootstrap])

  // Delay the visual loader by 400 ms so a fast bootstrap doesn't
  // produce a spinner flash.
  useEffect(() => {
    if (!bootstrapping) return
    const t = window.setTimeout(() => setShowLoader(true), LOADER_DELAY_MS)
    return () => window.clearTimeout(t)
  }, [bootstrapping])

  // No vault yet → first-run launcher (pick a folder, or restore from GitHub).
  // Sits ahead of git init / bootstrap so restore can clone into an empty
  // folder before anything fills it.
  if (!hasVault) {
    return <VaultLauncher onReady={() => setHasVault(true)} />
  }

  if (!bootstrapping) return <>{children}</>

  return (
    <div className="flex h-full w-full items-center justify-center bg-background">
      {showLoader && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner />
          <span>Loading your notes…</span>
        </div>
      )}
    </div>
  )
}
