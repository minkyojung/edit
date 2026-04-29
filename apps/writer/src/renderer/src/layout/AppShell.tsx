import React, { useEffect } from 'react'
import { SidebarProvider, SidebarInset, SidebarTrigger } from '@/components/ui/sidebar'
import { Separator } from '@/components/ui/separator'
import { AppSidebar } from './Sidebar'
import { ContextPanel } from './ContextPanel'
import { useLayoutStore } from '@/state/layoutStore'

interface AppShellProps {
  children: React.ReactNode
  bottomLeft?: React.ReactNode
}

export function AppShell({ children, bottomLeft }: AppShellProps) {
  const { sidebarOpen, contextPanelOpen, setSidebar, toggleContextPanel, setContextPanel } =
    useLayoutStore()

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
      style={{ '--sidebar-width': '200px' } as React.CSSProperties}
    >
      <AppSidebar />
      <SidebarInset className="overflow-hidden">
        {/* 사이드바 닫혔을 때 재열기 버튼 — 신호등 공간(72px) 이후 */}
        {!sidebarOpen && (
          <div className="absolute top-[5px] left-[76px] z-10 [-webkit-app-region:no-drag]">
            <SidebarTrigger />
          </div>
        )}
        <div className="flex h-full">
          <div className="relative flex-1 overflow-y-auto">
            {children}
            {bottomLeft && (
              <div className="absolute bottom-3 left-3 z-30">
                {bottomLeft}
              </div>
            )}
          </div>
          <Separator
            orientation="vertical"
            className="transition-opacity duration-200"
            style={{ opacity: contextPanelOpen ? 1 : 0 }}
          />
          <div
            className="shrink-0 h-full overflow-hidden transition-all duration-200 ease-in-out"
            style={{ width: contextPanelOpen ? 320 : 0 }}
          >
            <div className="w-[320px] h-full">
              <ContextPanel />
            </div>
          </div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
