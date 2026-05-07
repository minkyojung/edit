// Compact view-picker for the sidebar header. Replaces the inline
// Day/Week/Month tab strip — now that there's only ever one view
// visible at a time, surfacing the choice as a header dropdown
// frees the sidebar body for the view itself and keeps the chrome
// row dense.
//
// Sits to the left of the SidebarTrigger so the header reads:
//   [drag region] [▾ Day] [⊟]

import { IconChevronDown } from '@tabler/icons-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { useDocsStore } from '@/state/docsStore'

const VIEW_LABELS: Record<'day' | 'week' | 'month', string> = {
  day: 'Day',
  week: 'Week',
  month: 'Month',
}

export function SidebarDateMenu() {
  const tab = useDocsStore((s) => s.sidebarTab)
  const setTab = useDocsStore((s) => s.setSidebarTab)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex h-7 items-center gap-1 rounded-md px-2 text-[12px] font-medium',
            'text-foreground transition-colors hover:bg-accent/50',
            'outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
          )}
        >
          <span>{VIEW_LABELS[tab]}</span>
          <IconChevronDown size={12} stroke={1.75} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-28">
        <DropdownMenuItem onSelect={() => setTab('day')}>Day</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setTab('week')}>Week</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setTab('month')}>Month</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
