import { useState } from 'react'
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
import { useCollabDoc } from '@/hooks/useCollabDoc'

export function App() {
  const { handle, status } = useCollabDoc()
  const [view, setView] = useState<EditorView | null>(null)

  return (
    <ThemeProvider defaultPalette="charcoal" storageKey="writer-palette">
      <TooltipProvider delayDuration={200}>
        <ErrorBoundary
          FallbackComponent={FullPageErrorFallback}
          onError={(error, info) => console.error('[app] uncaught render error', error, info)}
        >
          <HashRouter>
            <AppShell oauthStatus="unauthenticated" collabHandle={handle} editorView={view}>
              <Routes>
                <Route path="/" element={<Navigate to="/notes" replace />} />
                <Route
                  path="/notes"
                  element={<MilkdownEditor handle={handle} status={status} onViewReady={setView} />}
                />
                <Route path="/wiki" element={<WikiView />} />
              </Routes>
            </AppShell>
            <MarkPopoverLayer editorView={view} ydoc={handle?.ydoc ?? null} />
          </HashRouter>
        </ErrorBoundary>
      </TooltipProvider>
    </ThemeProvider>
  )
}
