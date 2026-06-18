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
import { getActiveVaultPath } from '@/state/settingsStore'
import { VaultLauncher } from '@/components/VaultLauncher'
import { exists, remove } from '@tauri-apps/plugin-fs'
import { join } from '@tauri-apps/api/path'
import { cleanupYdocV2 } from '@/lib/cleanupYdocV2'
import { flattenVaultV1 } from '@/lib/flattenVaultV1'
import { migrateConventionsIntoClaudeMdV1 } from '@/lib/migrateConventionsIntoClaudeMdV1'
import { seedClaudeMd } from '@/lib/seedClaudeMd'

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
  // Whether the stored vault path has been verified to still exist on disk.
  // A path can be remembered across sessions but the folder later moved,
  // deleted, parked on an unmounted drive, or not-yet-synced (iCloud). We
  // must NOT boot into a missing folder: scanVault would throw and bootstrap
  // has no catch, so the app hangs on the loader forever with no way out.
  const [vaultChecked, setVaultChecked] = useState(false)

  // Verify the stored vault still exists before booting into it. If it's
  // gone, fall back to the launcher (re-pick / restore) instead of hanging.
  useEffect(() => {
    let cancelled = false
    const verify = async () => {
      const path = getActiveVaultPath()
      if (path) {
        try {
          if (!(await exists(path)) && !cancelled) setHasVault(false)
        } catch {
          // Treat an unreadable path the same as missing — route to the
          // launcher rather than letting the boot sequence stumble into it.
          if (!cancelled) setHasVault(false)
        }
      }
      if (!cancelled) setVaultChecked(true)
    }
    void verify()
    return () => {
      cancelled = true
    }
  }, [])

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
    // Wait until the vault path is both present AND verified to exist on
    // disk — never start the boot sequence against a missing folder.
    if (!hasVault || !vaultChecked) return
    const init = async () => {
      // NOTE: git history + GitHub backup + activity sync were disabled here
      // (kept only GitHub login). The vault `.md` files remain the single durable
      // source — docFileSync still flushes to disk. Versioning/backup will be
      // redesigned as an opt-in layer later; the dead modules (gitStore, vault_sync,
      // ReviewPanel, …) are slated for a separate deletion pass.
      //
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
      // Flat-vault migration: remove the retired `daily/` folder so the
      // scan below never surfaces legacy daily/writing files. Sentinel-
      // gated; runs the delete exactly once per vault.
      try {
        await flattenVaultV1()
      } catch (err) {
        console.warn('[boot] flatten-vault migration failed', err)
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
      // Conventions-merge migration: fold any existing
      // `_system/conventions.md` into CLAUDE.md, then retire the old page.
      // Runs AFTER the CLAUDE.md seed (so existing vaults append to their
      // own file) and BEFORE bootstrap (so the scan sees the consolidated
      // layout). Sentinel-gated; existing vaults pay the copy cost once.
      try {
        await migrateConventionsIntoClaudeMdV1()
      } catch (err) {
        console.warn('[boot] conventions-merge migration failed', err)
      }
      bootstrap()
      // Load chat thread metas + turns from `threads/`. Fires in
      // parallel with bootstrap because the two read disjoint paths
      // (docs read `wiki/` / `daily/` / `_system/`, threads read
      // `threads/`). hydrate is idempotent so StrictMode's double-
      // mount is safe.
      void useThreadsStore.getState().hydrate()
    }
    void init()
  }, [hasVault, vaultChecked, bootstrap])

  // Delay the visual loader by 400 ms so a fast bootstrap doesn't
  // produce a spinner flash.
  useEffect(() => {
    if (!bootstrapping) return
    const t = window.setTimeout(() => setShowLoader(true), LOADER_DELAY_MS)
    return () => window.clearTimeout(t)
  }, [bootstrapping])

  const loadingView = (
    <div className="flex h-full w-full items-center justify-center bg-background">
      {showLoader && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner />
          <span>Loading your notes…</span>
        </div>
      )}
    </div>
  )

  // Still verifying the stored vault exists — hold the loader rather than
  // flashing the launcher or booting into a folder that may be missing.
  if (!vaultChecked) return loadingView

  // No vault yet (or the stored one is gone) → first-run launcher (pick a
  // folder, or restore from GitHub). Sits ahead of git init / bootstrap so
  // restore can clone into an empty folder before anything fills it.
  if (!hasVault) {
    return <VaultLauncher onReady={() => setHasVault(true)} />
  }

  if (!bootstrapping) return <>{children}</>

  return loadingView
}
