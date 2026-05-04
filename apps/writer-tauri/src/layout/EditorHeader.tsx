// Top window-chrome row above the editor canvas. Sits at --header-h so it
// lines up with the sidebar header and the chat panel's matching header row.
//
// Layout zones, left to right:
//   1. Traffic-light spacer (--traffic-light-w). Drag region — gives
//      macOS room to paint the stoplight buttons over our content.
//      Renders even when the sidebar is open so the editor's content
//      stays at a stable x-coordinate regardless of sidebar state.
//   2. Sidebar trigger — only when the sidebar is collapsed; sits
//      right next to the stoplights, matching how Linear / Cursor
//      tuck their reveal-sidebar control.
//   3. Center slot — drag region. Reserved for breadcrumb / doc
//      context once we land that.
//   4. Actions slot — reserved for export / share / right-sidebar
//      toggle. Empty for now.
//
// Document tabs live in their own row below this one (see AppShell).
// We deliberately omit a bottom divider here so the header reads as a
// continuation of the window chrome — the divider sits under the tab
// row instead, matching Cursor / VS Code.

import { IconLayoutSidebarRightFilled } from '@tabler/icons-react'
import { SidebarTrigger } from '@/components/ui/sidebar'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useLayoutStore } from '@/state/layoutStore'

interface EditorHeaderProps {
  showSidebarTrigger: boolean
}

export function EditorHeader({ showSidebarTrigger }: EditorHeaderProps) {
  return (
    <div
      className="flex shrink-0 items-center border-b border-border bg-background"
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
      <div data-tauri-drag-region className="h-full flex-1" />
      <div className="flex items-center pr-2">
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
      <TooltipContent side="bottom">{open ? 'Hide chat panel' : 'Show chat panel'} ⌘.</TooltipContent>
    </Tooltip>
  )
}
