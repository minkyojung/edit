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

interface EditorHeaderProps {
  showSidebarTrigger: boolean
  editorView: EditorView | null
  /** Collab status surfaced next to the actions cluster. Connected
   * docs render no label so a healthy connection reads as a clean
   * header. */
  collabStatus?: CollabStatus
}

const STATUS_LABEL: Record<CollabStatus, string | null> = {
  loading: 'Starting…',
  ready: null,
  error: 'Storage error',
}

// Shared Tahoe-style chrome treatment for single-button capsules
// (SidebarTrigger, ContextPanelTrigger) and pill groups
// (NavHistoryButtons). Same fill / border / inner highlight / bottom
// rim shadow so all three read as one chrome family. Buttons get
// rounded-full so the Button's default rounded-4xl is overridden and
// the border traces a clean circle.
const TAHOE_CHROME =
  'rounded-full border border-foreground/10 bg-foreground/[0.06] shadow-[inset_0_1px_0_color-mix(in_oklch,var(--foreground)_8%,transparent),0_1px_0_color-mix(in_oklch,var(--background)_60%,transparent)] hover:bg-foreground/[0.08]'

export function EditorHeader({
  showSidebarTrigger,
  editorView,
  collabStatus,
}: EditorHeaderProps) {
  const statusLabel = collabStatus ? STATUS_LABEL[collabStatus] : null
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
        <SidebarTrigger className={TAHOE_CHROME} />
        <NavHistoryButtons />
      </div>
      <div className="flex min-w-0 flex-1 items-center justify-center">
        <EditorTabs />
      </div>
      <div className="flex flex-1 items-center justify-end gap-2 pr-3">
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
        <DocMenu editorView={editorView} />
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
          variant="ghost"
          size="icon-sm"
          onClick={toggle}
          className={cn(
            'relative cursor-pointer transition-colors',
            TAHOE_CHROME,
            open ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
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
