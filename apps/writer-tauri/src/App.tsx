import { useEffect, useState } from 'react'
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import { ErrorBoundary } from 'react-error-boundary'
import type { EditorView } from '@milkdown/kit/prose/view'
import { ThemeProvider } from '@/components/theme-provider'
import { AppToaster } from '@/components/AppToaster'
import { EngineGate } from '@/components/EngineGate'
import { TooltipProvider } from '@/components/ui/tooltip'
import { FullPageErrorFallback } from '@/components/ErrorFallback'
import { MarkPopoverLayer } from '@/components/agent/MarkPopoverLayer'
import { MarkHoverActionsLayer } from '@/components/agent/MarkHoverActionsLayer'
import { AppShell } from '@/layout/AppShell'
import { MilkdownEditor } from '@/editor/MilkdownEditor'
import { CommandPalette } from '@/layout/CommandPalette'
import { useDocsStore } from '@/state/docsStore'
import { useEditorViewStore } from '@/state/editorViewStore'
import { useIdleTrigger } from '@/hooks/useIdleTrigger'
import { useApplyPendingMarks } from '@/hooks/useApplyPendingMarks'

export function App() {
  return (
    <ThemeProvider defaultPalette="charcoal" storageKey="writer-palette">
      <TooltipProvider delayDuration={200}>
        <EngineGate>
          <AppContent />
        </EngineGate>
        <AppToaster />
      </TooltipProvider>
    </ThemeProvider>
  )
}

// Everything inside EngineGate — bootstrap calls hit the proof-server
// the moment they fire, so we keep them gated behind a healthy engine.
function AppContent() {
  const bootstrap = useDocsStore((s) => s.bootstrap)
  const activeSlug = useDocsStore((s) => s.activeSlug)
  const handles = useDocsStore((s) => s.handles)
  const statusMap = useDocsStore((s) => s.status)
  const [view, setView] = useState<EditorView | null>(null)

  useEffect(() => {
    bootstrap()
  }, [bootstrap])

  // Karpathy "Memories" idle pass — runs ingest in the background
  // after the user has been quiet for `idleMinutes`. Mounted once
  // here at the root so a single timer covers the whole session.
  useIdleTrigger()
  // Lazily materializes queued ingest proposals as proofSuggestion
  // marks the moment the user navigates to a target wiki page.
  // Pairs with the Review action on IngestProposalCard, which is
  // itself just "navigate to the first target — marks appear there".
  useApplyPendingMarks()

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
                <MilkdownEditor
                  key={activeSlug ?? 'no-doc'}
                  handle={activeHandle}
                  status={activeStatus}
                  onViewReady={(v) => {
                    // Mirror into the global store so non-React
                    // consumers (ingest apply, future palette
                    // commands) can reach the live view without
                    // prop drilling. Local state stays the source
                    // of truth for sibling renders below.
                    setView(v)
                    useEditorViewStore.getState().setView(v)
                  }}
                />
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
