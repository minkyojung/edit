import { useState } from 'react'
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import { ErrorBoundary } from 'react-error-boundary'
import type { EditorView } from '@milkdown/kit/prose/view'
import { ThemeProvider } from '@/components/theme-provider'
import { AppToaster } from '@/components/AppToaster'
import { EngineGate } from '@/components/EngineGate'
import { BootGate } from '@/components/BootGate'
import { TooltipProvider } from '@/components/ui/tooltip'
import { FullPageErrorFallback } from '@/components/ErrorFallback'
import { MarkPopoverLayer } from '@/components/agent/MarkPopoverLayer'
import { MarkHoverActionsLayer } from '@/components/agent/MarkHoverActionsLayer'
import { AppShell } from '@/layout/AppShell'
import { MilkdownEditor } from '@/editor/MilkdownEditor'
import { CommandPalette } from '@/layout/CommandPalette'
import { WikiPageBanner } from '@/layout/WikiPageBanner'
import { useDocsStore } from '@/state/docsStore'
import { useEditorViewStore } from '@/state/editorViewStore'
import { useIdleTrigger } from '@/hooks/useIdleTrigger'
import { useApplyPendingLogs } from '@/hooks/useApplyPendingLogs'
import { useMigrateLegacyIngestMarks } from '@/hooks/useMigrateLegacyIngestMarks'

export function App() {
  return (
    <ThemeProvider defaultPalette="charcoal" storageKey="writer-palette">
      <TooltipProvider delayDuration={200}>
        <EngineGate>
          <BootGate>
            <AppContent />
          </BootGate>
        </EngineGate>
        <AppToaster />
      </TooltipProvider>
    </ThemeProvider>
  )
}

// Everything inside EngineGate + BootGate — by the time this renders,
// proof-server is healthy AND the catalog bootstrap has finished, so
// React subscriptions land on a stable store and the sidebar's first
// paint already reflects the user's real data.
function AppContent() {
  const activeSlug = useDocsStore((s) => s.activeSlug)
  const handles = useDocsStore((s) => s.handles)
  const statusMap = useDocsStore((s) => s.status)
  const [view, setView] = useState<EditorView | null>(null)

  // Karpathy "Memories" idle pass — runs ingest in the background
  // after the user has been quiet for `idleMinutes`. Mounted once
  // here at the root so a single timer covers the whole session.
  useIdleTrigger()
  // Drains queued wiki:log entries when the user navigates to the
  // log page. Wiki proposal review moved off the mark surface — see
  // WikiPageBanner (mounted inside the /notes route) for the
  // in-page inbox. This hook is now log-drain-only.
  useApplyPendingLogs()
  // One-time cleanup of legacy ingest-origin proofSuggestion marks
  // left over from the pre-banner era. Runs per wiki page on first
  // mount post-upgrade; no-op afterwards.
  useMigrateLegacyIngestMarks()

  const activeHandle = activeSlug ? handles[activeSlug] ?? null : null
  const activeStatus = activeSlug ? statusMap[activeSlug] ?? 'initializing' : 'initializing'

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
                  <MilkdownEditor
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
