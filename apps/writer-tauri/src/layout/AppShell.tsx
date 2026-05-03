import React, { useEffect } from 'react'
import { ErrorBoundary } from 'react-error-boundary'
import type { EditorView } from '@milkdown/kit/prose/view'
import { SidebarProvider, SidebarInset, SidebarTrigger } from '@/components/ui/sidebar'
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable'
import { usePanelRef } from 'react-resizable-panels'
import { PanelErrorFallback } from '@/components/ErrorFallback'
import { AppSidebar } from './Sidebar'
import { ChatPanel } from './ChatPanel'
import { CloseConfirmDialog } from '@/components/CloseConfirmDialog'
import { useLayoutStore } from '@/state/layoutStore'
import type { CollabHandle } from '@/hooks/useCollabDoc'

interface AppShellProps {
  children: React.ReactNode
  bottomLeft?: React.ReactNode
  documentContext?: string | null
  oauthStatus?: 'authenticated' | 'unauthenticated' | 'checking'
  collabHandle?: CollabHandle | null
  editorView?: EditorView | null
}

export function AppShell({ children, bottomLeft, collabHandle, editorView }: AppShellProps) {
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
      <AppSidebar />
      <SidebarInset className="overflow-hidden">
        {!sidebarOpen && (
          <div
            className="absolute inset-x-0 top-0 z-10 flex items-center"
            style={{ height: '31px' }}
          >
            <div data-tauri-drag-region className="w-[88px] h-full shrink-0" />
            <SidebarTrigger />
            <div data-tauri-drag-region className="flex-1 h-full" />
          </div>
        )}
        <ResizablePanelGroup orientation="horizontal" className="h-full">
          <ResizablePanel defaultSize={75} minSize={30}>
            <div className="relative h-full overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {children}
              {bottomLeft && (
                <div className="absolute bottom-3 left-3 z-30">
                  {bottomLeft}
                </div>
              )}
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
