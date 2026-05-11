// Top window-chrome row above the editor canvas. Sits at --header-h so it
// lines up with the sidebar header and the chat panel's matching header row.
//
// Layout zones, left to right:
//   1. Traffic-light spacer (--traffic-light-w). Drag region — gives
//      macOS room to paint the stoplight buttons over our content.
//      Only rendered when the sidebar is collapsed; otherwise the
//      sidebar paints over this region.
//   2. Sidebar trigger — only when the sidebar is collapsed; sits
//      right next to the stoplights, matching how Linear / Cursor
//      tuck their reveal-sidebar control.
//   3. Document tabs — pulled up from their own row so the second
//      header row can host the formatting toolbar. The strip is the
//      flexible slot, and the macOS window-drag area collapses to
//      the traffic-light spacer (sufficient for normal use).
//   4. Collab status label — surfaced just before actions when the
//      doc isn't connected; hidden during a healthy connection.
//   5. Actions — DocMenu + chat-panel toggle.

import { IconLayoutSidebarRightFilled } from '@tabler/icons-react'
import type { EditorView } from '@milkdown/kit/prose/view'
import { SidebarTrigger } from '@/components/ui/sidebar'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useLayoutStore } from '@/state/layoutStore'
import { EditorTabs } from '@/editor/EditorTabs'
import type { CollabStatus } from '@/hooks/useCollabDoc'
import { DocMenu } from './DocMenu'

interface EditorHeaderProps {
  showSidebarTrigger: boolean
  editorView: EditorView | null
  /** Collab status surfaced next to the actions cluster. Connected
   * docs render no label so a healthy connection reads as a clean
   * header. */
  collabStatus?: CollabStatus
}

const STATUS_LABEL: Record<CollabStatus, string | null> = {
  initializing: 'Starting…',
  connecting: 'Connecting…',
  connected: null,
  error: 'Offline',
}

export function EditorHeader({
  showSidebarTrigger,
  editorView,
  collabStatus,
}: EditorHeaderProps) {
  const statusLabel = collabStatus ? STATUS_LABEL[collabStatus] : null
  return (
    <div
      className="flex shrink-0 items-center border-b border-border bg-card"
      style={{ height: 'var(--header-h)' }}
    >
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
      <div className="flex min-w-0 flex-1 items-stretch px-2">
        <EditorTabs />
      </div>
      {statusLabel && (
        <span
          className={cn(
            'shrink-0 px-2 text-xs',
            collabStatus === 'error' ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          {statusLabel}
        </span>
      )}
      <div className="flex shrink-0 items-center gap-0.5 pr-1">
        <DocMenu editorView={editorView} />
        <ContextPanelTrigger />
      </div>
    </div>
  )
}

function ContextPanelTrigger() {
  const open = useLayoutStore((s) => s.contextPanelOpen)
  const toggle = useLayoutStore((s) => s.toggleContextPanel)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={toggle}
          className={cn(
            'cursor-pointer transition-colors',
            open ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
          aria-label={open ? 'Hide chat panel' : 'Show chat panel'}
          aria-pressed={open}
        >
          <IconLayoutSidebarRightFilled size={16} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{open ? 'Hide chat panel' : 'Show chat panel'}</TooltipContent>
    </Tooltip>
  )
}
