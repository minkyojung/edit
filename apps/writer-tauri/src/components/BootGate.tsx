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
// First-launch BootstrapDialog: BootGate triggers the dialog by
// calling settingsStore.openBootstrapDialog() once after bootstrap
// completes (when bootstrapCompleted is still false). The actual
// dialog mounts inside AppContent so the ProfileBanner regenerate
// flow can re-open it later without remounting the entire app.

import { useEffect, useState } from 'react'
import { Spinner } from '@/components/ui/spinner'
import { useDocsStore } from '@/state/docsStore'
import { getActiveVaultPath, useSettingsStore } from '@/state/settingsStore'
import { pickVault } from '@/lib/vaultPicker'

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
      bootstrap()
    }
    void init()
  }, [bootstrap])

  // Once bootstrap finishes, trigger the first-launch BootstrapDialog
  // exactly once when the user hasn't completed it yet. The dialog
  // itself lives in AppContent (mounted alongside the editor) so the
  // ProfileBanner regenerate action can re-open it mid-session
  // without remounting the app.
  useEffect(() => {
    if (bootstrapping) return
    const { bootstrapCompleted, bootstrapDialogOpen, openBootstrapDialog } =
      useSettingsStore.getState()
    if (!bootstrapCompleted && !bootstrapDialogOpen) {
      openBootstrapDialog()
    }
  }, [bootstrapping])

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
