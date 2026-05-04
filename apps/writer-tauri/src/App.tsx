import { useEffect, useState } from 'react'
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import { ErrorBoundary } from 'react-error-boundary'
import type { EditorView } from '@milkdown/kit/prose/view'
import { ThemeProvider } from '@/components/theme-provider'
import { TooltipProvider } from '@/components/ui/tooltip'
import { FullPageErrorFallback } from '@/components/ErrorFallback'
import { MarkPopoverLayer } from '@/components/agent/MarkPopoverLayer'
import { AppShell } from '@/layout/AppShell'
import { MilkdownEditor } from '@/editor/MilkdownEditor'
import { WikiView } from '@/views/WikiView'
import { CommandPalette } from '@/layout/CommandPalette'
import { useDocsStore } from '@/state/docsStore'

export function App() {
  const bootstrap = useDocsStore((s) => s.bootstrap)
  const activeSlug = useDocsStore((s) => s.activeSlug)
  const handles = useDocsStore((s) => s.handles)
  const statusMap = useDocsStore((s) => s.status)
  const [view, setView] = useState<EditorView | null>(null)

  useEffect(() => {
    bootstrap()
  }, [bootstrap])

  const activeHandle = activeSlug ? handles[activeSlug] ?? null : null
  const activeStatus = activeSlug ? statusMap[activeSlug] ?? 'initializing' : 'initializing'

  return (
    <ThemeProvider defaultPalette="charcoal" storageKey="writer-palette">
      <TooltipProvider delayDuration={200}>
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
                      onViewReady={setView}
                    />
                  }
                />
                <Route path="/wiki" element={<WikiView />} />
              </Routes>
            </AppShell>
            <MarkPopoverLayer editorView={view} ydoc={activeHandle?.ydoc ?? null} />
            <CommandPalette />
          </HashRouter>
        </ErrorBoundary>
      </TooltipProvider>
    </ThemeProvider>
  )
}
