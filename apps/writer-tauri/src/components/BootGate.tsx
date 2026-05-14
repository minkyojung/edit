// Blocks the app UI until docsStore.bootstrap() finishes — same
// shape as EngineGate, second floor up in the gate stack:
//
//   EngineGate (proof-server health)
//     └─ BootGate (catalog bootstrap)
//          └─ AppContent
//
// What bootstrap() does, and why we wait for it before any UI
// renders:
//
//   1. Migrate the legacy single-slug localStorage entry into a
//      catalog-shaped daily so existing content survives the
//      multi-doc rewrite.
//   2. Ensure today's daily exists in the catalog (creating it on
//      the server if missing).
//   3. Wire the active slug + connect its collab handle.
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

import { useEffect, useState } from 'react'
import { Spinner } from '@/components/ui/spinner'
import { useDocsStore } from '@/state/docsStore'

const LOADER_DELAY_MS = 400 // same as EngineGate — keep flashes off fast boots

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
  useEffect(() => {
    bootstrap()
  }, [bootstrap])

  // Delay the visual loader by 400 ms so a fast bootstrap doesn't
  // produce a spinner flash. Matches EngineGate's behaviour.
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
