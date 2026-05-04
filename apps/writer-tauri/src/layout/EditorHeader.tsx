// Top bar above the editor canvas. Sits at --header-h so it lines up
// with the sidebar header and the chat panel's tab strip.
//
// Layout zones, left to right:
//   1. Traffic-light spacer (--traffic-light-w). Drag region — gives
//      macOS room to paint the stoplight buttons over our content.
//      Renders even when the sidebar is open so the editor's content
//      stays at a stable x-coordinate regardless of sidebar state.
//   2. Sidebar trigger — only when the sidebar is collapsed; sits
//      right next to the stoplights, matching how Linear / Cursor
//      tuck their reveal-sidebar control.
//   3. Title / tabs slot — currently shows the document title (read
//      from the same Y.Doc as the body via useDocTitle). When we add
//      multi-document tabs later, swap the inner span for a Radix
//      Tabs strip; the slot's flex-1 + drag-region behavior stays.
//   4. Actions slot — empty for now; reserved for share / export /
//      doc-level menu when those land.

import { SidebarTrigger } from '@/components/ui/sidebar'
import { EditorTabs } from '@/editor/EditorTabs'

interface EditorHeaderProps {
  showSidebarTrigger: boolean
}

export function EditorHeader({ showSidebarTrigger }: EditorHeaderProps) {
  return (
    <div
      className="flex shrink-0 items-center border-b border-border bg-background"
      style={{ height: 'var(--header-h)' }}
    >
      {/* Traffic-light spacer only renders while the sidebar is
          collapsed — when the sidebar is open, macOS draws the
          stoplights over the sidebar's header instead, so the
          editor's content can start at its own left edge. */}
      {showSidebarTrigger && (
        <>
          <div
            data-tauri-drag-region
            className="h-full shrink-0"
            style={{ width: 'var(--traffic-light-w)' }}
          />
          <SidebarTrigger />
        </>
      )}
      <div className="flex flex-1 items-center px-2">
        <EditorTabs />
      </div>
      <div className="flex items-center pr-2" />
    </div>
  )
}
