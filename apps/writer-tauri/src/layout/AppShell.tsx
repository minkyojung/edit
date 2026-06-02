import React, { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { ErrorBoundary } from 'react-error-boundary'
import type { EditorView } from '@milkdown/kit/prose/view'
import { SidebarProvider, SidebarInset } from '@/components/ui/sidebar'
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable'
import { usePanelRef } from 'react-resizable-panels'
import { PanelErrorFallback } from '@/components/ErrorFallback'
import { AppSidebar } from './Sidebar'
import { RightPanel } from './RightPanel'
import { EditorHeader } from './EditorHeader'
import { CloseConfirmDialog } from '@/components/CloseConfirmDialog'
import { useLayoutStore } from '@/state/layoutStore'
import type { CollabHandle, CollabStatus } from '@/hooks/useCollabDoc'

interface AppShellProps {
  children: React.ReactNode
  bottomLeft?: React.ReactNode
  documentContext?: string | null
  oauthStatus?: 'authenticated' | 'unauthenticated' | 'checking'
  collabHandle?: CollabHandle | null
  collabStatus?: CollabStatus
  editorView?: EditorView | null
}

export function AppShell({ children, bottomLeft, collabHandle, collabStatus, editorView }: AppShellProps) {
  const { sidebarOpen, contextPanelOpen, setSidebar, togglePanels, setContextPanel } =
    useLayoutStore()
  const contextPanelRef = usePanelRef()
  const navigate = useNavigate()

  useEffect(() => {
    const panel = contextPanelRef.current
    if (!panel) return
    if (contextPanelOpen) {
      panel.expand()
    } else {
      panel.collapse()
    }
  }, [contextPanelOpen])

  useEffect(() => {
    // App-level meta shortcuts. All three operate on the window scope
    // so they fire whether or not the editor has focus — matching how
    // Safari / Arc / VSCode treat back/forward. ⌘[ / ⌘] aren't bound
    // anywhere in the milkdown / prose keymap (verified during the
    // step-4 audit), so window-level capture doesn't compete with
    // text editing.
    function handleKeyDown(e: KeyboardEvent) {
      if (!e.metaKey) return
      if (e.key === '[') {
        e.preventDefault()
        navigate(-1)
        return
      }
      if (e.key === ']') {
        e.preventDefault()
        navigate(1)
        return
      }
      if (e.key === '.') {
        e.preventDefault()
        togglePanels()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [togglePanels, navigate])

  return (
    <SidebarProvider
      open={sidebarOpen}
      onOpenChange={setSidebar}
    >
      <CloseConfirmDialog />
      <AppSidebar />
      <SidebarInset className="overflow-hidden">
        <ResizablePanelGroup orientation="horizontal" className="h-full">
          <ResizablePanel defaultSize={75} minSize={40}>
            <div data-editor-panel className="relative flex h-full flex-col">
              <EditorHeader
                showSidebarTrigger={!sidebarOpen}
                editorView={editorView ?? null}
                collabStatus={collabStatus}
              />
              <div className="relative min-h-0 flex-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {children}
                {bottomLeft && (
                  <div className="absolute bottom-3 left-3 z-overlay">
                    {bottomLeft}
                  </div>
                )}
              </div>
            </div>
          </ResizablePanel>

          {/* after:top + after:bottom override the default after:inset-y-0
              so the handle's hit-area starts BELOW the header row. Without
              this, the handle's invisible drag zone overlapped the editor
              header's ContextPanelTrigger and swallowed every click on it. */}
          <ResizableHandle className="bg-transparent data-[resize-handle-state=hover]:bg-sidebar-border/60 data-[resize-handle-state=drag]:bg-sidebar-border transition-colors after:top-[var(--header-h)] after:bottom-0" />

          <ResizablePanel
            panelRef={contextPanelRef}
            defaultSize="25%"
            minSize="15%"
            maxSize="45%"
            collapsible
            collapsedSize={0}
            onResize={(size) => {
              const collapsed = size.asPercentage < 1
              if (collapsed !== !contextPanelOpen) {
                setContextPanel(!collapsed)
              }
            }}
          >
            {/* The right panel reads as its own floating card. It owns its
                window gap directly — py- for top/bottom, pr- for the right
                edge, all --window-inset — because the SidebarInset inset
                variant is inactive (Sidebar uses variant="sidebar"), so the
                card would otherwise touch the window's top/bottom. Left edge
                sits against the resize handle (no gap). One consequence: the
                card top is --window-inset below the window, so its header
                sits that much lower than the editor header. bg-sidebar fill. */}
            <div className="h-full py-[var(--window-inset)] pr-[var(--window-inset)]">
              {/* Corner curve = --surface-radius (an independent design value,
                  not gap-derived) so the card stays this round as the gap
                  changes. It's kept ≥ --window-radius − --window-inset, so the
                  corner never goes squarer than the window's rounding and pokes
                  into it. Matches the editor's rounded-l-[var(--surface-radius)]. */}
              <div className="h-full overflow-hidden rounded-[var(--surface-radius)] bg-sidebar">
                <ErrorBoundary
                  FallbackComponent={PanelErrorFallback}
                  onError={(error, info) => console.error('[right-panel] error', error, info)}
                >
                  <RightPanel
                    editorView={editorView ?? null}
                    slug={collabHandle?.slug ?? null}
                  />
                </ErrorBoundary>
              </div>
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </SidebarInset>
    </SidebarProvider>
  )
}
