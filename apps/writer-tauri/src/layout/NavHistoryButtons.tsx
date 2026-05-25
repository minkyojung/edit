/**
 * NavHistoryButtons — back / forward through the route history.
 *
 * Pairs with the ⌘[ / ⌘] shortcuts in AppShell. The buttons are
 * always enabled: react-router's hash history doesn't expose a
 * reliable past/future depth (POP doesn't disambiguate back from
 * forward), and the native browser arrows behave the same way.
 * A click with nothing to navigate to is a harmless no-op.
 */

import { IconArrowLeft, IconArrowRight } from '@tabler/icons-react'
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
    // Tahoe-style pill group: a single rounded-full container with
    // a subtle fill, a 1px outer border that hugs the whole capsule,
    // an inner top highlight, and a 1px bottom rim shadow for the
    // "Liquid Glass" emboss. No divider between the two buttons —
    // hover wash on the active button is the only thing that
    // distinguishes them, matching macOS Tahoe's nav-history pill.
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
            className="rounded-full hover:bg-foreground/[0.08]"
            onClick={() => navigate(-1)}
            aria-label="Go back"
          >
            <IconArrowLeft size={16} stroke={1.75} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Back (⌘[)</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="rounded-full hover:bg-foreground/[0.08]"
            onClick={() => navigate(1)}
            aria-label="Go forward"
          >
            <IconArrowRight size={16} stroke={1.75} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Forward (⌘])</TooltipContent>
      </Tooltip>
    </div>
  )
}
