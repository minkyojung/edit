import React, { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ErrorBoundary } from 'react-error-boundary'
import { SidebarProvider, SidebarInset } from '@/components/ui/sidebar'
import { PanelErrorFallback } from '@/components/ErrorFallback'
import { AppSidebar } from './Sidebar'
import { RightPanel } from './RightPanel'
import { EditorHeader } from './EditorHeader'
import { CloseConfirmDialog } from '@/components/CloseConfirmDialog'
import { useLayoutStore } from '@/state/layoutStore'
import { useWindowModeStore } from '@/state/windowModeStore'
import type { CollabHandle, CollabStatus } from '@/hooks/useCollabDoc'

interface AppShellProps {
  children: React.ReactNode
  bottomLeft?: React.ReactNode
  documentContext?: string | null
  oauthStatus?: 'authenticated' | 'unauthenticated' | 'checking'
  collabHandle?: CollabHandle | null
  collabStatus?: CollabStatus
}

// Inspector (right panel) width bounds, in px. Fixed-width column — the
// editor flexes, this stays put on window resize.
// MIN is the "controls don't squish" floor: the header keeps its tab strip +
// a fixed control cluster, and the chat body needs a usable column. Dragging
// below MIN (minus the deadzone) closes the panel rather than shrinking it.
const PANEL_MIN_W = 300
const PANEL_MAX_W = 560
// Default = the narrowest panel where the composer's ModeToggle shows its label
// (icon + "Auto-accept edits"), not just the icon. That label appears via a
// container query at footer ≥ 440px, and the footer sits inside ~37px of insets
// (composer px = --surface-inset 8×2, PromptInput p-2.5 10×2, ~1px border), so
// 440 + 37 ≈ 477 → round to 478 so the label reliably shows on first open.
const PANEL_DEFAULT_W = 478
const PANEL_CLOSE_SLOP = 28
// Left sidebar width bounds, in px.
//
// MIN is content-derived: the header keeps 5 shrink-0 action buttons
// (size-8 = 32px, gap-1 = 4px) to the RIGHT of the 80px traffic-light reserve.
// Below this width the row would clip, so this is the "buttons don't squish"
// floor. Dragging below MIN (minus a deadzone) closes the sidebar rather than
// shrinking it further.
//   80 (traffic-light reserve) + 5×32 (buttons) + 6×4 (gaps) + 12 (pr-3) = 276
const SIDEBAR_MIN_W = 80 + 5 * 32 + 6 * 4 + 12
const SIDEBAR_MAX_W = 360
// Default must be ≥ MIN so the header never starts clipped.
const SIDEBAR_DEFAULT_W = 300
// Extra drag past MIN before the sidebar snaps closed. Hysteresis: within
// [MIN-SLOP, MIN] the width rubber-bands to MIN; only past the slop do we close,
// so the boundary can't flicker open/closed.
const SIDEBAR_CLOSE_SLOP = 28
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

// Persist the dragged widths so they survive reloads (open/closed state already
// persists via layoutStore). Read once at mount, clamped to current bounds so a
// stale value from an older build can't resurrect an out-of-range width.
const SIDEBAR_WIDTH_KEY = 'ui:sidebar-width'
const PANEL_WIDTH_KEY = 'ui:panel-width'
const loadWidth = (key: string, def: number, lo: number, hi: number): number => {
  if (typeof window === 'undefined') return def
  const n = parseInt(window.localStorage.getItem(key) ?? '', 10)
  return Number.isFinite(n) ? clamp(n, lo, hi) : def
}

export function AppShell({ children, bottomLeft, collabHandle, collabStatus }: AppShellProps) {
  const { sidebarOpen, contextPanelOpen, setSidebar, setContextPanel, togglePanels } =
    useLayoutStore()
  // Compact (Raycast-Notes) mode hides the sidebar + right panel so only the
  // editor title + body remain. The window itself is resized by the store; here
  // we just collapse the surrounding chrome to match.
  const compact = useWindowModeStore((s) => s.mode) === 'compact'
  const navigate = useNavigate()
  const [panelWidth, setPanelWidth] = useState(() =>
    loadWidth(PANEL_WIDTH_KEY, PANEL_DEFAULT_W, PANEL_MIN_W, PANEL_MAX_W),
  )
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    loadWidth(SIDEBAR_WIDTH_KEY, SIDEBAR_DEFAULT_W, SIDEBAR_MIN_W, SIDEBAR_MAX_W),
  )
  // True only while a sidebar drag is in flight, so the shadcn open/close
  // width transition can be suppressed — otherwise the eased sidebar edge
  // trails the (instant) handle and they visibly separate mid-drag.
  const [resizingSidebar, setResizingSidebar] = useState(false)
  // Same idea for the right panel: instant width during a drag, eased on
  // open/close so the collapse animation matches the left sidebar's.
  const [resizingPanel, setResizingPanel] = useState(false)

  // Persist widths ~300ms after they settle (so a drag writes once on release,
  // not every frame).
  useEffect(() => {
    const id = setTimeout(
      () => window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth)),
      300,
    )
    return () => clearTimeout(id)
  }, [sidebarWidth])
  useEffect(() => {
    const id = setTimeout(
      () => window.localStorage.setItem(PANEL_WIDTH_KEY, String(panelWidth)),
      300,
    )
    return () => clearTimeout(id)
  }, [panelWidth])

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

  // Drag-to-resize the inspector. This is the ONLY JS in the resize story —
  // the column layout itself is CSS flex, so window resizes are reflowed by
  // the browser synchronously (no ResizeObserver round-trip → no wobble).
  // Dragging the handle left widens the panel.
  const startResize = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      const startX = e.clientX
      const startW = panelWidth
      setResizingPanel(true)
      function cleanup() {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        setResizingPanel(false)
      }
      function onMove(ev: PointerEvent) {
        // Handle sits on the panel's LEFT edge, so dragging left widens.
        const raw = startW + (startX - ev.clientX)
        // Dragged decisively below the floor → close via the existing panel
        // state (same treatment as the left sidebar), not a new width-0 state.
        if (raw < PANEL_MIN_W - PANEL_CLOSE_SLOP) {
          cleanup()
          setContextPanel(false)
          return
        }
        setPanelWidth(clamp(raw, PANEL_MIN_W, PANEL_MAX_W))
      }
      function onUp() {
        cleanup()
      }
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [panelWidth, setContextPanel],
  )

  const nudgeWidth = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        setPanelWidth((w) => clamp(w + 16, PANEL_MIN_W, PANEL_MAX_W))
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        const next = panelWidth - 16
        if (next < PANEL_MIN_W - PANEL_CLOSE_SLOP) setContextPanel(false)
        else setPanelWidth(clamp(next, PANEL_MIN_W, PANEL_MAX_W))
      }
    },
    [panelWidth, setContextPanel],
  )

  // Drag-to-resize the left sidebar. Mirror of startResize; dragging the
  // handle right widens. Width is published as the --sidebar-width CSS var
  // on the SidebarProvider (below), which the shadcn gap + container both
  // consume — so both reflow together.
  const startSidebarResize = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      const startX = e.clientX
      const startW = sidebarWidth
      setResizingSidebar(true)
      // Function declarations (hoisted) so cleanup can reference onMove/onUp
      // and onMove can trigger cleanup when it snaps the sidebar closed.
      function cleanup() {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        setResizingSidebar(false)
      }
      function onMove(ev: PointerEvent) {
        const raw = startW + (ev.clientX - startX)
        // Dragged decisively below the "don't squish" floor → close via the
        // existing offcanvas state (NOT a new width-0 state), so the toggle,
        // ⌘-shortcut, editor reflow and cookie all keep working as one machine.
        if (raw < SIDEBAR_MIN_W - SIDEBAR_CLOSE_SLOP) {
          cleanup()
          setSidebar(false)
          return
        }
        setSidebarWidth(clamp(raw, SIDEBAR_MIN_W, SIDEBAR_MAX_W))
      }
      function onUp() {
        cleanup()
      }
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [sidebarWidth, setSidebar],
  )

  const nudgeSidebarWidth = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        const next = sidebarWidth - 16
        if (next < SIDEBAR_MIN_W - SIDEBAR_CLOSE_SLOP) setSidebar(false)
        else setSidebarWidth(clamp(next, SIDEBAR_MIN_W, SIDEBAR_MAX_W))
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        setSidebarWidth((w) => clamp(w + 16, SIDEBAR_MIN_W, SIDEBAR_MAX_W))
      }
    },
    [sidebarWidth, setSidebar],
  )

  return (
    <SidebarProvider
      // In compact mode force the sidebar off-canvas (no unmount — the same
      // collapsed state the user gets via the toggle), so the editor column
      // takes the whole small window.
      open={compact ? false : sidebarOpen}
      onOpenChange={setSidebar}
      // Override the shadcn default (220px constant) with live state. The var
      // cascades to the gap + container which both read w-(--sidebar-width).
      style={{ '--sidebar-width': `${sidebarWidth}px` } as React.CSSProperties}
      // Suppresses the width transition on the gap/container while dragging.
      data-resizing={resizingSidebar ? '' : undefined}
    >
      <CloseConfirmDialog />
      <AppSidebar />

      {/* Sidebar resize handle. Fixed at the sidebar's right edge (left =
          current width); only mounted while the sidebar is open (off-canvas
          when closed, nothing to resize). Sits above the z-10 container. */}
      {sidebarOpen && !compact && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          aria-valuenow={sidebarWidth}
          aria-valuemin={SIDEBAR_MIN_W}
          aria-valuemax={SIDEBAR_MAX_W}
          tabIndex={0}
          onPointerDown={startSidebarResize}
          onKeyDown={nudgeSidebarWidth}
          style={{ left: sidebarWidth }}
          className="fixed inset-y-0 z-20 w-px cursor-col-resize bg-transparent transition-colors hover:bg-sidebar-border/60 focus-visible:bg-sidebar-border focus-visible:outline-none after:absolute after:inset-y-0 after:left-1/2 after:w-2 after:-translate-x-1/2"
        />
      )}
      <SidebarInset className="overflow-hidden">
        {/* Layout is plain CSS flex, NOT react-resizable-panels. The editor
            takes the remaining space (flex-1) and the inspector is a fixed
            px column (shrink-0). On window resize the browser reflows this
            in the same frame, so the panel can't lag/wobble the way the
            library's JS + ResizeObserver sizing model did (it recomputes
            flex-grow a frame late). Drag-to-resize is the only JS; window
            resizes touch no JS at all. */}
        <div className="flex h-full">
          <div
            data-editor-panel
            className="relative flex h-full min-w-0 flex-1 flex-col bg-background"
          >
            <EditorHeader
              showSidebarTrigger={!sidebarOpen}
              collabStatus={collabStatus}
              compact={compact}
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

          {/* Resize handle. Only mounted while the panel is open (nothing to
              resize otherwise). after:top-[var(--header-h)] keeps the wider
              hit-area BELOW the header row so it doesn't swallow clicks on the
              editor header's ContextPanelTrigger. */}
          {contextPanelOpen && !compact && (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize chat panel"
              aria-valuenow={panelWidth}
              aria-valuemin={PANEL_MIN_W}
              aria-valuemax={PANEL_MAX_W}
              tabIndex={0}
              onPointerDown={startResize}
              onKeyDown={nudgeWidth}
              className="relative w-px shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-sidebar-border/60 focus-visible:bg-sidebar-border focus-visible:outline-none after:absolute after:top-[var(--header-h)] after:bottom-0 after:left-1/2 after:w-2 after:-translate-x-1/2"
            />
          )}

          {/* Inspector. Fixed px width; 0 when closed but still mounted, so
              reopening doesn't re-mount RightPanel and flicker. overflow-hidden
              clips the content while collapsed. */}
          <div
            className={`relative h-full shrink-0 overflow-hidden border-l border-sidebar-border bg-background${
              // Eased on open/close to match the left sidebar's collapse; off
              // during a drag so the edge tracks the handle 1:1.
              resizingPanel ? '' : ' transition-[width] duration-200 ease-tahoe'
            }`}
            // Collapsed to 0 in compact (and kept mounted, like the closed
            // state) so the small window is editor-only.
            style={{ width: contextPanelOpen && !compact ? panelWidth : 0 }}
          >
            {/* Flush column, mirroring the left sidebar — no window gap, no
                rounding. The seam is this border-l (the left sidebar's border-r
                counterpart); the resize handle is a transparent hit area on top
                of it. With the inset gone the panel header lines up with the
                editor header (both start at --header-h). bg-background fill,
                matching the editor. */}
            <ErrorBoundary
              FallbackComponent={PanelErrorFallback}
              onError={(error, info) => console.error('[right-panel] error', error, info)}
            >
              <RightPanel slug={collabHandle?.slug ?? null} />
            </ErrorBoundary>
          </div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
