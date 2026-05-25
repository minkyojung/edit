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

          <ResizableHandle className="bg-transparent data-[resize-handle-state=hover]:bg-sidebar-border/60 data-[resize-handle-state=drag]:bg-sidebar-border transition-colors" />

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
            <ErrorBoundary
              FallbackComponent={PanelErrorFallback}
              onError={(error, info) => console.error('[right-panel] error', error, info)}
            >
              <RightPanel
                editorView={editorView ?? null}
                ydoc={collabHandle?.ydoc ?? null}
                slug={collabHandle?.slug ?? null}
              />
            </ErrorBoundary>
          </ResizablePanel>
        </ResizablePanelGroup>
      </SidebarInset>
    </SidebarProvider>
  )
}
