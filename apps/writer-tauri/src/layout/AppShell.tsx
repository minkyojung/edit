import React, { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ErrorBoundary } from 'react-error-boundary'
import type { EditorView } from '@milkdown/kit/prose/view'
import { SidebarProvider, SidebarInset } from '@/components/ui/sidebar'
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

// Inspector (right panel) width bounds, in px. Fixed-width column — the
// editor flexes, this stays put on window resize.
const PANEL_MIN_W = 300
const PANEL_MAX_W = 560
const PANEL_DEFAULT_W = 440
// Left sidebar width bounds, in px. DEFAULT matches the shadcn SIDEBAR_WIDTH
// constant (220px) so nothing shifts until the user drags.
const SIDEBAR_MIN_W = 180
const SIDEBAR_MAX_W = 360
const SIDEBAR_DEFAULT_W = 260
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

export function AppShell({ children, bottomLeft, collabHandle, collabStatus, editorView }: AppShellProps) {
  const { sidebarOpen, contextPanelOpen, chatMaximized, setSidebar, togglePanels } = useLayoutStore()
  // Maximize only takes effect while the panel is actually open; the
  // toggle lives in the panel header, but Cmd+. can close the panel
  // while maximized is still set.
  const maximized = chatMaximized && contextPanelOpen
  const navigate = useNavigate()
  const [panelWidth, setPanelWidth] = useState(PANEL_DEFAULT_W)
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT_W)
  // True only while a sidebar drag is in flight, so the shadcn open/close
  // width transition can be suppressed — otherwise the eased sidebar edge
  // trails the (instant) handle and they visibly separate mid-drag.
  const [resizingSidebar, setResizingSidebar] = useState(false)

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
      const onMove = (ev: PointerEvent) => {
        setPanelWidth(clamp(startW + (startX - ev.clientX), PANEL_MIN_W, PANEL_MAX_W))
      }
      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [panelWidth],
  )

  const nudgeWidth = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      setPanelWidth((w) => clamp(w + 16, PANEL_MIN_W, PANEL_MAX_W))
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      setPanelWidth((w) => clamp(w - 16, PANEL_MIN_W, PANEL_MAX_W))
    }
  }, [])

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
      const onMove = (ev: PointerEvent) => {
        setSidebarWidth(clamp(startW + (ev.clientX - startX), SIDEBAR_MIN_W, SIDEBAR_MAX_W))
      }
      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        setResizingSidebar(false)
      }
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [sidebarWidth],
  )

  const nudgeSidebarWidth = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      setSidebarWidth((w) => clamp(w - 16, SIDEBAR_MIN_W, SIDEBAR_MAX_W))
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      setSidebarWidth((w) => clamp(w + 16, SIDEBAR_MIN_W, SIDEBAR_MAX_W))
    }
  }, [])

  return (
    <SidebarProvider
      open={sidebarOpen}
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
      {sidebarOpen && (
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
            className={`relative h-full min-w-0 flex-1 flex-col bg-background ${maximized ? 'hidden' : 'flex'}`}
          >
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

          {/* Resize handle. Only mounted while the panel is open (nothing to
              resize otherwise). after:top-[var(--header-h)] keeps the wider
              hit-area BELOW the header row so it doesn't swallow clicks on the
              editor header's ContextPanelTrigger. */}
          {contextPanelOpen && !maximized && (
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
            className={`relative h-full overflow-hidden bg-background ${
              maximized ? 'flex-1' : 'shrink-0 border-l border-sidebar-border'
            }`}
            style={maximized ? undefined : { width: contextPanelOpen ? panelWidth : 0 }}
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
              <RightPanel
                editorView={editorView ?? null}
                slug={collabHandle?.slug ?? null}
              />
            </ErrorBoundary>
          </div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
