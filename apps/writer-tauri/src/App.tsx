import { useState } from 'react'
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import { ErrorBoundary } from 'react-error-boundary'
import type { EditorView } from '@milkdown/kit/prose/view'
import { ThemeProvider } from '@/components/theme-provider'
import { AppToaster } from '@/components/AppToaster'
import { BootGate } from '@/components/BootGate'
import { TooltipProvider } from '@/components/ui/tooltip'
import { FullPageErrorFallback } from '@/components/ErrorFallback'
import { MarkPopoverLayer } from '@/components/agent/MarkPopoverLayer'
import { MarkHoverActionsLayer } from '@/components/agent/MarkHoverActionsLayer'
import { AppShell } from '@/layout/AppShell'
import { Page } from '@/layout/Page'
import { CommandPalette } from '@/layout/CommandPalette'
import { WikiPageBanner } from '@/layout/WikiPageBanner'
import { useDocsStore } from '@/state/docsStore'
import { useEditorViewStore } from '@/state/editorViewStore'
import { useIdleTrigger } from '@/hooks/useIdleTrigger'
import {
  useLazyMaterialize,
  type LazyMaterializeConfig,
} from '@/hooks/useLazyMaterialize'
import { useMigrateLegacyIngestMarks } from '@/hooks/useMigrateLegacyIngestMarks'
import { applyPendingLogsForView } from '@/agent/applyIngest'
// Phase 4.A — dev-only side-effect imports. Each module registers
// a `window.__X` handle so the picker / vault I/O is reachable from
// DevTools before real UI wiring lands. Real callers (settings
// panel, boot-time prompt, file watcher) will import these for
// their actual API and the dev handles fall away.
import '@/lib/vaultPicker'
import '@/lib/vault'
import '@/lib/scanVault'
import { initHeadlessParser } from '@/lib/headlessMilkdown'
import { startAutoFlush } from '@/lib/docFileSync'
import { startVaultWatcher } from '@/lib/vaultWatcher'

// Path C Step 3c — boot the headless Milkdown so parser / serializer
// land in editorViewStore before any doc-loading code runs. Without
// this, applyVaultToHandle (called from buildHandle's contentReady)
// would race the per-doc MilkdownEditor mount and silently fall back
// to 'no-parser', leaving the body empty on every fresh open.
void initHeadlessParser()

// Phase 4.B.1.b.iv.2 — begin the periodic vault flush loop on app
// load. Idempotent: safe under React StrictMode's double-mount and
// against any future caller that might also start it. Currently a
// dummy console-log tick; iv.3 swaps in the real save pipeline.
startAutoFlush()

// Phase 4.E.1 — start watching the vault folder for external edits.
// Logging-only for now (no mutations); we use this baseline to
// verify the Tauri watch API works on macOS and to observe the
// shape of fsevents before wiring 4.E.2's router. The watcher is
// gated on getActiveVaultPath() inside startVaultWatcher — when
// BootGate's auto-picker is still up, it logs an inert message and
// no-ops. Re-invocation after the picker completes lands in 4.E.2.
void startVaultWatcher()

// Module-scope so the configs array reference is stable across
// renders — required by useLazyMaterialize's caller contract
// (configs.length must be constant; React enforces it for the
// per-config hook calls inside).
const SYSTEM_DRAIN_CONFIGS: LazyMaterializeConfig[] = [
  {
    matchType: 'system:log',
    queueSelector: (s) => s.pendingLogs,
    applyForView: applyPendingLogsForView,
    signaturePrefix: 'log',
  },
  // system:index used to live here too — it now writes deterministically
  // from state/wikiIndex.ts on every wiki change, no queue needed.
]

export function App() {
  return (
    <ThemeProvider defaultPalette="charcoal" storageKey="writer-palette">
      <TooltipProvider delayDuration={200}>
        <BootGate>
          <AppContent />
        </BootGate>
        <AppToaster />
      </TooltipProvider>
    </ThemeProvider>
  )
}

// Everything inside BootGate — by the time this renders, the catalog
// bootstrap has finished, so React subscriptions land on a stable
// store and the sidebar's first paint reflects the user's real data.
function AppContent() {
  const activeSlug = useDocsStore((s) => s.activeSlug)
  const handles = useDocsStore((s) => s.handles)
  const statusMap = useDocsStore((s) => s.status)
  const [view, setView] = useState<EditorView | null>(null)

  // Karpathy "Memories" ingest — fires in the background when the
  // user navigates away from a daily, or when the local date rolls
  // over. Mounted once here at the root so subscriptions and the
  // date-poll timer share a single lifetime across the session.
  useIdleTrigger()
  // Drains queued log entries / index updates into their respective
  // system pages when the user navigates there. One hook, one
  // configs table — adding system:about or system:lint later is a
  // single config row above. Wiki proposal review (the third
  // ingest output) stays on the in-page banner surface, not in
  // this lazy-drain pipeline.
  useLazyMaterialize(SYSTEM_DRAIN_CONFIGS)
  // One-time cleanup of legacy ingest-origin proofSuggestion marks
  // left over from the pre-banner era. Runs per wiki page on first
  // mount post-upgrade; no-op afterwards.
  useMigrateLegacyIngestMarks()

  const activeHandle = activeSlug ? handles[activeSlug] ?? null : null
  const activeStatus = activeSlug ? statusMap[activeSlug] ?? 'loading' : 'loading'

  return (
    <ErrorBoundary
      FallbackComponent={FullPageErrorFallback}
      onError={(error, info) => console.error('[app] uncaught render error', error, info)}
    >
      <HashRouter>
        <AppShell
          oauthStatus="unauthenticated"
          collabHandle={activeHandle}
          collabStatus={activeStatus}
          editorView={view}
        >
          <Routes>
            <Route path="/" element={<Navigate to="/notes" replace />} />
            <Route
              path="/notes"
              element={
                <>
                  {/* Banner mounts above the editor and self-hides
                      when the active doc isn't a wiki:* page with
                      pending proposals. Lives in the scroll area
                      so it doesn't shift layout when it appears/
                      disappears. */}
                  <WikiPageBanner />
                  <Page
                    key={activeSlug ?? 'no-doc'}
                    handle={activeHandle}
                    status={activeStatus}
                    onViewReady={(v) => {
                      // Mirror into the global store so non-React
                      // consumers (banner accept, future palette
                      // commands) can reach the live view without
                      // prop drilling. Local state stays the source
                      // of truth for sibling renders below.
                      setView(v)
                      useEditorViewStore.getState().setView(v)
                    }}
                  />
                </>
              }
            />
          </Routes>
        </AppShell>
        <MarkHoverActionsLayer editorView={view} ydoc={activeHandle?.ydoc ?? null} />
        <MarkPopoverLayer editorView={view} ydoc={activeHandle?.ydoc ?? null} />
        <CommandPalette />
      </HashRouter>
    </ErrorBoundary>
  )
}
