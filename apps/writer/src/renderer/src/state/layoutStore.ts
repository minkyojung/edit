import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface LayoutState {
  sidebarOpen: boolean
  contextPanelOpen: boolean
  toggleSidebar: () => void
  toggleContextPanel: () => void
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
