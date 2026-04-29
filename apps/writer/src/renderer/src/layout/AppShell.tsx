import React, { useEffect } from 'react'
import { Sidebar } from './Sidebar'
import { ContextPanel } from './ContextPanel'
import { Separator } from '@/components/ui/separator'
import { useLayoutStore } from '@/state/layoutStore'

interface AppShellProps {
  children: React.ReactNode
}

export function AppShell({ children }: AppShellProps) {
  const { sidebarOpen, contextPanelOpen, toggleSidebar, toggleContextPanel, setSidebar, setContextPanel } =
    useLayoutStore()

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!e.metaKey) return

      if (e.key === '1') {
        e.preventDefault()
        toggleSidebar()
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
  }, [toggleSidebar, toggleContextPanel, setSidebar, setContextPanel])

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* 좌측 사이드바 */}
      <div
        className="shrink-0 h-full overflow-hidden transition-all duration-200 ease-in-out"
        style={{ width: sidebarOpen ? 240 : 0 }}
      >
        <div className="w-[240px] h-full">
          <Sidebar />
        </div>
      </div>

      <Separator
        orientation="vertical"
        className="transition-opacity duration-200"
        style={{ opacity: sidebarOpen ? 1 : 0 }}
      />

      {/* 중앙 콘텐츠 */}
      <main className="flex-1 overflow-y-auto">
        {children}
      </main>

      <Separator
        orientation="vertical"
        className="transition-opacity duration-200"
        style={{ opacity: contextPanelOpen ? 1 : 0 }}
      />

      {/* 우측 컨텍스트 패널 */}
      <div
        className="shrink-0 h-full overflow-hidden transition-all duration-200 ease-in-out"
        style={{ width: contextPanelOpen ? 320 : 0 }}
      >
        <div className="w-[320px] h-full">
          <ContextPanel />
        </div>
      </div>
    </div>
  )
}
