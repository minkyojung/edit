// Compact view-picker for the sidebar header. Replaces the inline
// Day/Week/Month tab strip — now that there's only ever one view
// visible at a time, surfacing the choice as a header dropdown
// frees the sidebar body for the view itself and keeps the chrome
// row dense.
//
// Sits to the left of the SidebarTrigger so the header reads:
//   [drag region] [▾ Day] [⊟]

import { IconChevronDown } from '@tabler/icons-react'
import { useNavigate } from 'react-router-dom'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { useDocsStore } from '@/state/docsStore'
import { useActiveSlug } from '@/hooks/useActiveSlug'
import { buildViewUrl, type SidebarTab } from '@/lib/viewUrl'

const VIEW_LABELS: Record<SidebarTab, string> = {
  day: 'Day',
  week: 'Week',
  month: 'Month',
}

export function SidebarDateMenu() {
  const tab = useDocsStore((s) => s.sidebarTab)
  const dayAnchor = useDocsStore((s) => s.dayAnchor)
  const monthAnchor = useDocsStore((s) => s.monthAnchor)
  const activeSlug = useActiveSlug()
  const navigate = useNavigate()

  const goTo = (next: SidebarTab) => {
    navigate(buildViewUrl({ tab: next, dayAnchor, monthAnchor, slug: activeSlug }))
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex h-7 items-center gap-1 rounded-xl px-2 text-[12px] font-medium',
            'text-sidebar-trigger transition-colors hover:text-sidebar-accent-foreground',
            'outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/40',
          )}
        >
          <span>{VIEW_LABELS[tab]}</span>
          <IconChevronDown size={12} stroke={1.75} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-28">
        <DropdownMenuItem onSelect={() => goTo('day')}>Day</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => goTo('week')}>Week</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => goTo('month')}>Month</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
