import React, { useEffect } from 'react'
import { ErrorBoundary } from 'react-error-boundary'
import type { EditorView } from '@milkdown/kit/prose/view'
import { SidebarProvider, SidebarInset } from '@/components/ui/sidebar'
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable'
import { usePanelRef } from 'react-resizable-panels'
import { PanelErrorFallback } from '@/components/ErrorFallback'
import { AppSidebar } from './Sidebar'
import { ChatPanel } from './ChatPanel'
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
  const { sidebarOpen, contextPanelOpen, setSidebar, toggleContextPanel, setContextPanel } =
    useLayoutStore()
  const contextPanelRef = usePanelRef()

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
    function handleKeyDown(e: KeyboardEvent) {
      if (!e.metaKey) return

      if (e.key === '1') {
        e.preventDefault()
        setSidebar(!sidebarOpen)
      } else if (e.key === '.') {
        e.preventDefault()
        toggleContextPanel()
      } else if (e.key === '\\') {
        e.preventDefault()
        setSidebar(false)
        setContextPanel(false)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [sidebarOpen, setSidebar, toggleContextPanel, setContextPanel])

  return (
    <SidebarProvider
      open={sidebarOpen}
      onOpenChange={setSidebar}
      style={{ '--sidebar-width': '220px' } as React.CSSProperties}
    >
      <CloseConfirmDialog />
      <AppSidebar collabStatus={collabStatus} />
      <SidebarInset className="overflow-hidden">
        <ResizablePanelGroup orientation="horizontal" className="h-full">
          <ResizablePanel defaultSize={75} minSize={30}>
            <div className="relative flex h-full flex-col">
              <EditorHeader
                ydoc={collabHandle?.ydoc ?? null}
                showSidebarTrigger={!sidebarOpen}
              />
              <div className="relative flex-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
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
            maxSize="50%"
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
              onError={(error, info) => console.error('[chat-panel] error', error, info)}
            >
              <ChatPanel
                editorView={editorView ?? null}
                ydoc={collabHandle?.ydoc ?? null}
                provider={collabHandle?.provider ?? null}
                slug={collabHandle?.slug ?? null}
              />
            </ErrorBoundary>
          </ResizablePanel>
        </ResizablePanelGroup>
      </SidebarInset>
    </SidebarProvider>
  )
}
