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
import { pickVault } from '@/lib/vaultPicker'
import {
  gitInit,
  gitHeadTimestamp,
  gitEnsureGitignoreEntries,
} from '@/lib/git'
import { cleanupYdocV2 } from '@/lib/cleanupYdocV2'

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

  // Fire bootstrap once on mount. The store's bootstrap is idempotent
  // (it short-circuits when the catalog already has today's daily),
  // but React's Strict Mode would still double-call this useEffect —
  // hence the idempotency on the store side, not a guard here.
  //
  // Path C precondition: a vault must be selected before bootstrap so
  // every doc the bootstrap touches (today's daily + system pages) can
  // immediately reach disk. We block on the OS picker until the user
  // chooses a folder; cancelling falls through to bootstrap-without-
  // vault, which silent-skips every disk write. That's a degraded but
  // recoverable state — user can re-run picker from DevTools, or quit
  // and relaunch to get the prompt again.
  useEffect(() => {
    const init = async () => {
      if (!getActiveVaultPath()) {
        await pickVault()
      }
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
        ])
      } catch (err) {
        console.warn('[boot] gitignore migration failed', err)
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
  }, [bootstrap])

  // Delay the visual loader by 400 ms so a fast bootstrap doesn't
  // produce a spinner flash.
  useEffect(() => {
    if (!bootstrapping) return
    const t = window.setTimeout(() => setShowLoader(true), LOADER_DELAY_MS)
    return () => window.clearTimeout(t)
  }, [bootstrapping])

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
