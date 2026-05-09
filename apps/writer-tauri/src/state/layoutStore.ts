import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface LayoutState {
  sidebarOpen: boolean
  contextPanelOpen: boolean
  toggleSidebar: () => void
  toggleContextPanel: () => void
  // Toggle both panels together. If either side is open, both close.
  // If both are closed, both open. Bound to Cmd+. so a single chord
  // either reveals both rails for navigation/chat or hides everything
  // for a clean writing surface.
  togglePanels: () => void
  setSidebar: (open: boolean) => void
  setContextPanel: (open: boolean) => void
}

export const useLayoutStore = create<LayoutState>()(
  persist(
    (set) => ({
      sidebarOpen: true,
      contextPanelOpen: false,
      toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
      toggleContextPanel: () => set((s) => ({ contextPanelOpen: !s.contextPanelOpen })),
      togglePanels: () =>
        set((s) => {
          const anyOpen = s.sidebarOpen || s.contextPanelOpen
          return anyOpen
            ? { sidebarOpen: false, contextPanelOpen: false }
            : { sidebarOpen: true, contextPanelOpen: true }
        }),
      setSidebar: (open) => set({ sidebarOpen: open }),
      setContextPanel: (open) => set({ contextPanelOpen: open }),
    }),
    {
      name: 'layout-state',
      version: 1,
      partialize: (s) => ({ sidebarOpen: s.sidebarOpen, contextPanelOpen: s.contextPanelOpen }),
    }
  )
)
