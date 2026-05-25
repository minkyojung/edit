/**
 * NavHistoryButtons — back / forward through the route history.
 *
 * Pairs with the ⌘[ / ⌘] shortcuts in AppShell. The buttons are
 * always enabled: react-router's hash history doesn't expose a
 * reliable past/future depth (POP doesn't disambiguate back from
 * forward), and the native browser arrows behave the same way.
 * A click with nothing to navigate to is a harmless no-op.
 */

import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { TAHOE_CHROME } from '@/lib/chrome'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

export function NavHistoryButtons() {
  const navigate = useNavigate()
  return (
    // Tahoe-style pill: a single rounded-full capsule from chrome.ts,
    // with a short faint 1px divider between the two buttons to hint
    // at the group split without a hard outline. Icons use chevrons
    // (no horizontal stem) and the text color matches the other
    // header chrome (muted-foreground → foreground on hover) so the
    // pill reads as part of the same family as SidebarTrigger and
    // ContextPanelTrigger.
    <div
      className={`inline-flex h-8 items-center ${TAHOE_CHROME}`}
      role="group"
      aria-label="Navigation history"
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="rounded-full text-muted-foreground hover:bg-foreground/[0.08] hover:text-foreground"
            onClick={() => navigate(-1)}
            aria-label="Go back"
          >
            <IconChevronLeft size={16} stroke={1.75} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Back (⌘[)</TooltipContent>
      </Tooltip>
      <span
        aria-hidden
        className="h-3 w-px shrink-0 bg-foreground/15"
      />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="rounded-full text-muted-foreground hover:bg-foreground/[0.08] hover:text-foreground"
            onClick={() => navigate(1)}
            aria-label="Go forward"
          >
            <IconChevronRight size={16} stroke={1.75} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Forward (⌘])</TooltipContent>
      </Tooltip>
    </div>
  )
}
