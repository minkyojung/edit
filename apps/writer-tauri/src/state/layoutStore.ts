import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/** Which surface the right-hand panel currently shows. The panel
 * itself (open/closed, width) is tracked separately via
 * `contextPanelOpen` — the two combine like vim split-windows where
 * the window can be hidden but still remembers what was last in it. */
export type RightPanelMode = 'chat' | 'review'

interface LayoutState {
  sidebarOpen: boolean
  contextPanelOpen: boolean
  /** Active surface inside the right panel. Persisted so a user who
   * closed the app on Review re-opens to Review. Default 'chat'
   * matches the pre-Phase-1 behaviour where the panel was always
   * chat-only. */
  rightPanelMode: RightPanelMode
  toggleSidebar: () => void
  toggleContextPanel: () => void
  // Toggle both panels together. If either side is open, both close.
  // If both are closed, both open. Bound to Cmd+. so a single chord
  // either reveals both rails for navigation/chat or hides everything
  // for a clean writing surface.
  togglePanels: () => void
  setSidebar: (open: boolean) => void
  setContextPanel: (open: boolean) => void
  /** Switch the right panel's surface. Doesn't change open/closed
   * state; callers that want "open + switch in one click" use
   * `openRightPanelInMode(mode)` below. */
  setRightPanelMode: (mode: RightPanelMode) => void
  /** Open the right panel AND switch it to `mode` in one step. The
   * common path from a header button (e.g. clicking the Review badge
   * while the panel is closed). */
  openRightPanelInMode: (mode: RightPanelMode) => void
}

export const useLayoutStore = create<LayoutState>()(
  persist(
    (set) => ({
      sidebarOpen: true,
      contextPanelOpen: false,
      rightPanelMode: 'chat',
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
      setRightPanelMode: (mode) => set({ rightPanelMode: mode }),
      openRightPanelInMode: (mode) =>
        set({ contextPanelOpen: true, rightPanelMode: mode }),
    }),
    {
      name: 'layout-state',
      // v2: added `rightPanelMode`. Old v1 state has no field; zustand
      // discards on version mismatch without a migrate, which falls
      // back to the default 'chat' — same as the pre-feature behaviour,
      // so the bump is functionally invisible.
      version: 2,
      partialize: (s) => ({
        sidebarOpen: s.sidebarOpen,
        contextPanelOpen: s.contextPanelOpen,
        rightPanelMode: s.rightPanelMode,
      }),
    }
  )
)
