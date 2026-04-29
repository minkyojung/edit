import React, { useEffect } from 'react'
import { SidebarProvider, SidebarInset, SidebarTrigger } from '@/components/ui/sidebar'
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable'
import { usePanelRef } from 'react-resizable-panels'
import { AppSidebar } from './Sidebar'
import { ContextPanel } from './ContextPanel'
import { useLayoutStore } from '@/state/layoutStore'

interface AppShellProps {
  children: React.ReactNode
  bottomLeft?: React.ReactNode
  documentContext?: string | null
}

export function AppShell({ children, bottomLeft, documentContext }: AppShellProps) {
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
      style={{ '--sidebar-width': '168px' } as React.CSSProperties}
    >
      <AppSidebar />
      <SidebarInset className="overflow-hidden">
        {!sidebarOpen && (
          <div className="absolute top-[5px] left-[76px] z-10 [-webkit-app-region:no-drag]">
            <SidebarTrigger />
          </div>
        )}
        <ResizablePanelGroup orientation="horizontal" className="h-full">
          <ResizablePanel defaultSize={75} minSize={30}>
            <div className="relative h-full overflow-y-auto">
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
            <ContextPanel documentContext={documentContext ?? null} />
          </ResizablePanel>
        </ResizablePanelGroup>
      </SidebarInset>
    </SidebarProvider>
  )
}
