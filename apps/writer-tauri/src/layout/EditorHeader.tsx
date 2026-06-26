// Top window-chrome row above the editor canvas. Sits at --header-h so it
// lines up with the sidebar header and the chat panel's matching header row.
// Header buttons are plain icon-only ghost buttons (no filled chrome),
// matching the sidebar header's icon buttons.
//
// Structure: a 3-column flex row. Equal flex-1 columns so the centered
// active-doc label sits in the visual middle regardless of how the side
// clusters grow.
//
//   ┌───────────────────────┬───────────────────────┬───────────────────────┐
//   │ Left cluster          │ Center                │ Right cluster         │
//   │ pl-3, gap-2           │ justify-center        │ pr-3, gap-2, end      │
//   │                       │                       │                       │
//   │ [stoplight spacer]*   │ <EditorTabs>          │ [collab status]?      │
//   │ <SidebarTrigger>      │  (active-doc chip)    │ <DocMenu>             │
//   │ <NavHistoryButtons>   │                       │ <ContextPanelTrigger> │
//   └───────────────────────┴───────────────────────┴───────────────────────┘
//   * Stoplight spacer is only rendered when the sidebar is collapsed —
//     otherwise the sidebar paints over the traffic-light zone and the
//     editor header starts right after the sidebar's right edge.
//
// The whole row is data-tauri-drag-region so empty bands between the
// clusters double as window-drag handles. Interactive children
// (buttons, the active-doc chip's pointer-events-auto column) opt out
// of dragging via the standard Tauri exclusion list.

import { IconLayoutSidebarRightFilled } from '@tabler/icons-react'
import { useMatch } from 'react-router-dom'
import { SidebarTrigger } from '@/components/ui/sidebar'
import { Button } from '@/components/ui/button'
import { NavHistoryButtons } from './NavHistoryButtons'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useLayoutStore } from '@/state/layoutStore'
import { useGitStore } from '@/state/gitStore'
import { EditorTabs } from '@/editor/EditorTabs'
import type { CollabStatus } from '@/hooks/useCollabDoc'
import { DocMenu } from './DocMenu'
import { FileViewerHeaderTitle } from './FileViewer'

interface EditorHeaderProps {
  showSidebarTrigger: boolean
  /** Collab status surfaced next to the actions cluster. Connected
   * docs render no label so a healthy connection reads as a clean
   * header. */
  collabStatus?: CollabStatus
}

// Only the hard-error case surfaces in the header — it's the one
// status the user must act on. A normal load is near-instant (local
// file hydrate) so showing it just adds noise in the happy path and
// reads as wrong when no doc is open at all. The "load is taking too
// long" signal already lives in the footer behind a grace window.
const STATUS_LABEL: Record<CollabStatus, string | null> = {
  loading: null,
  ready: null,
  error: 'Storage error',
}


export function EditorHeader({
  showSidebarTrigger,
  collabStatus,
}: EditorHeaderProps) {
  const statusLabel = collabStatus ? STATUS_LABEL[collabStatus] : null
  // On a file route (`/file/:rel`) the center slot shows the file's name
  // + Open action instead of the active-doc label.
  const fileRel = useMatch('/file/:rel')?.params.rel ?? null
  return (
    <div
      data-tauri-drag-region
      className="absolute top-0 left-0 right-0 z-sticky flex items-center"
      style={{ height: 'var(--header-h)' }}
    >
      {/* Traffic-light reservation is only needed when the sidebar is
          collapsed — otherwise the sidebar paints over the stoplight
          zone and the editor header starts right after the sidebar. */}
      {showSidebarTrigger && (
        <div
          data-tauri-drag-region
          className="h-full shrink-0"
          style={{ width: 'var(--traffic-light-w)' }}
        />
      )}
      {/* 3-column layout: left cluster | center (EditorTabs) | right
          cluster. Each column is flex-1 so the center pin stays in the
          visual middle of the header, and the left/right cluster widths
          can vary (sidebar state, status label) without pushing the
          title off-center. min-w-0 lets the inner truncate kick in
          before the cluster columns shrink. */}
      <div
        data-tauri-drag-region
        className="flex flex-1 items-center gap-2 self-stretch pl-3"
      >
        <SidebarTrigger />
        <NavHistoryButtons />
      </div>
      <div
        className={cn(
          'flex min-w-0 items-center justify-center',
          // File titles tend to be long (full filenames), so give the
          // center a wider share on file routes while keeping the left/
          // right clusters equal so it stays visually centered.
          fileRel != null ? 'flex-[1.7]' : 'flex-1',
        )}
      >
        {fileRel != null ? (
          <FileViewerHeaderTitle rel={fileRel} />
        ) : (
          <EditorTabs />
        )}
      </div>
      <div className="flex flex-1 items-center justify-end gap-2 pr-3">
        {statusLabel && (
          <span
            className={cn(
              'shrink-0 px-2 text-caption',
              collabStatus === 'error' ? 'text-destructive' : 'text-muted-foreground',
            )}
          >
            {statusLabel}
          </span>
        )}
        <DocMenu />
        <ContextPanelTrigger />
      </div>
    </div>
  )
}

function ContextPanelTrigger() {
  const open = useLayoutStore((s) => s.contextPanelOpen)
  const toggle = useLayoutStore((s) => s.toggleContextPanel)
  // Activity count surfaces here so the user gets a visual signal
  // when the panel is closed AND there are unreviewed changes — the
  // alternative (no signal) would let history quietly pile up. When
  // the panel is open the tab badge inside RightPanelHeader carries
  // the same info, so we hide the dot here to avoid double-counting.
  const activityCount = useGitStore((s) => s.activity.length)
  const gitStatus = useGitStore((s) => s.status)
  const showDot = !open && (activityCount > 0 || gitStatus === 'error')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="iconGhost"
          size="icon-sm"
          onClick={toggle}
          className="relative cursor-pointer"
          aria-label={open ? 'Hide right panel' : 'Show right panel'}
          aria-pressed={open}
        >
          <IconLayoutSidebarRightFilled size={16} />
          {showDot && (
            <span
              className={cn(
                'absolute right-1 top-1 h-1.5 w-1.5 rounded-full',
                gitStatus === 'error' ? 'bg-destructive' : 'bg-primary',
              )}
              aria-hidden
            />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {open ? 'Hide right panel' : 'Show right panel'}
      </TooltipContent>
    </Tooltip>
  )
}
