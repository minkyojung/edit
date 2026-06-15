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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

export function NavHistoryButtons() {
  const navigate = useNavigate()
  return (
    // Icon-only back/forward — two plain ghost buttons, no pill chrome,
    // matching the rest of the header's icon buttons.
    <div
      className="inline-flex items-center"
      role="group"
      aria-label="Navigation history"
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-sidebar-foreground/60 hover:text-sidebar-foreground"
            onClick={() => navigate(-1)}
            aria-label="Go back"
          >
            <IconChevronLeft size={16} stroke={1.75} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Back (⌘[)</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-sidebar-foreground/60 hover:text-sidebar-foreground"
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
