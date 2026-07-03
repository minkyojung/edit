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

import {
  IconArrowsMaximize,
  IconArrowsMinimize,
  IconEdit,
  IconLayoutSidebarRightFilled,
  IconMessageCircleFilled,
  IconSearch,
} from '@tabler/icons-react'
import { useMatch, useNavigate } from 'react-router-dom'
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
import { useWindowModeStore } from '@/state/windowModeStore'
import { useDocsStore } from '@/state/docsStore'
import { useCommandPaletteStore } from '@/state/commandPaletteStore'
import { buildViewUrl } from '@/lib/viewUrl'
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
  /** Compact (Raycast-Notes) mode: the window is shrunk to a small panel.
   * The header drops to bare chrome — traffic-light room + the expand
   * button — so only the editor title + body remain. */
  compact?: boolean
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
  compact = false,
}: EditorHeaderProps) {
  const statusLabel = collabStatus ? STATUS_LABEL[collabStatus] : null
  // On a file route (`/file/:rel`) the center slot shows the file's name
  // + Open action instead of the active-doc label.
  const fileRel = useMatch('/file/:rel')?.params.rel ?? null

  // Compact mode: strip the header to the essentials — keep the traffic-light
  // reservation (no sidebar to paint it) and the expand button, drop tabs,
  // nav, sidebar trigger, and the right-panel toggle (those surfaces are
  // hidden in compact anyway).
  if (compact) {
    return (
      <div
        data-tauri-drag-region
        className="absolute top-0 left-0 right-0 z-sticky flex items-center"
        style={{ height: 'var(--header-h)' }}
      >
        <div
          data-tauri-drag-region
          className="h-full shrink-0"
          style={{ width: 'var(--traffic-light-w)' }}
        />
        <div data-tauri-drag-region className="flex-1 self-stretch" />
        <div className="flex shrink-0 items-center gap-0.5 pr-3">
          <CompactToggle compact />
          <CompactHeaderActions />
        </div>
        {/* Filename pinned and centered on the FULL window width — not the
            leftover space between the traffic lights and the toggle. Absolute +
            symmetric padding (traffic-light-w each side) keeps it at the true
            center while clearing both side clusters, so a long name truncates
            instead of sliding under them. In-body title is hidden in compact,
            so this is the single title surface. */}
        <div
          className="pointer-events-none absolute inset-x-0 flex justify-center"
          style={{
            paddingLeft: 'var(--traffic-light-w)',
            paddingRight: 'var(--traffic-light-w)',
          }}
        >
          <EditorTabs pinned />
        </div>
      </div>
    )
  }

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
        <CompactToggle />
        <ContextPanelTrigger />
      </div>
    </div>
  )
}

/** Shrinks the window to / restores it from the compact panel. Same button
 * in both modes; the glyph + label flip with the current mode. */
function CompactToggle({ compact = false }: { compact?: boolean }) {
  const toggle = useWindowModeStore((s) => s.toggle)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="iconGhost"
          size="icon-sm"
          onClick={() => void toggle()}
          className="cursor-pointer"
          aria-label={compact ? 'Expand window' : 'Compact window'}
        >
          {compact ? (
            <IconArrowsMaximize size={16} />
          ) : (
            <IconArrowsMinimize size={16} />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {compact ? 'Expand window · ⌘⌥C' : 'Compact window · ⌘⌥C'}
      </TooltipContent>
    </Tooltip>
  )
}

/** Compact-header quick actions: new note + search palette. Reuses the same
 * docsStore.createNew + commandPalette handlers as the sidebar header, so the
 * compact panel keeps those two flows without the full sidebar. */
function CompactHeaderActions() {
  const navigate = useNavigate()
  const createNew = useDocsStore((s) => s.createNew)
  const openPalette = useCommandPaletteStore((s) => s.openPalette)
  const toggleWindow = useWindowModeStore((s) => s.toggle)
  const openChat = useLayoutStore((s) => s.openRightPanelInMode)
  const requestChatFocus = useLayoutStore((s) => s.requestChatInputFocus)

  // Ask AI: leave the compact panel and land in the full editor with chat
  // open + focused. The note being written is the active doc, so the agent
  // already has it in context — no explicit attach needed.
  const handleAskAI = () => {
    openChat('chat')
    void toggleWindow() // compact → full
    requestChatFocus()
  }

  const handleCreateNew = () => {
    createNew()
      .then((slug) => {
        const store = useDocsStore.getState()
        navigate(
          buildViewUrl({
            tab: store.sidebarTab,
            dayAnchor: store.dayAnchor,
            monthAnchor: store.monthAnchor,
            slug,
          }),
        )
      })
      .catch((err) => console.error('[docs] createNew failed', err))
  }

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="iconGhost"
            size="icon-sm"
            onClick={handleCreateNew}
            className="cursor-pointer"
            aria-label="New note"
          >
            <IconEdit size={16} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">New note · ⌘N</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="iconGhost"
            size="icon-sm"
            onClick={() => openPalette()}
            className="cursor-pointer"
            aria-label="Search"
          >
            <IconSearch size={16} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Search · ⌘K</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="iconGhost"
            size="icon-sm"
            onClick={handleAskAI}
            className="cursor-pointer"
            aria-label="Ask AI"
          >
            <IconMessageCircleFilled size={16} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Ask AI</TooltipContent>
      </Tooltip>
    </>
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
