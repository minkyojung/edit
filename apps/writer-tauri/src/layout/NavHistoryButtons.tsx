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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

export function NavHistoryButtons() {
  const navigate = useNavigate()
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
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
            onClick={() => navigate(1)}
            aria-label="Go forward"
          >
            <IconArrowRight size={16} stroke={1.75} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Forward (⌘])</TooltipContent>
      </Tooltip>
    </>
  )
}
