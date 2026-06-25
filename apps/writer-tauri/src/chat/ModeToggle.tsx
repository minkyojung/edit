// Plan toggle for the PromptInput footer. Two mutually-exclusive modes, so a
// single on/off button rather than a menu:
//
//   off → Apply (default, acceptEdits): proposed changes auto-apply the instant
//     they land — no manual Keep (the diff still renders, already applied).
//   on  → Plan: read-only — explores and writes a plan but cannot edit
//     (permissionMode 'plan' + propose_* relays and Bash dropped).
//
// `edit` (review-each) stays a valid ChatMode for legacy threads but isn't
// reachable from here. Disabled while a turn streams (a switch wouldn't apply
// until the next send).

import { IconMap } from '@tabler/icons-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { ChatMode } from '@/chat/types'
import { cn } from '@/lib/utils'

interface Props {
  value: ChatMode
  onChange: (next: ChatMode) => void
  disabled?: boolean
}

export function ModeToggle({ value, onChange, disabled }: Props) {
  const isPlan = value === 'plan'
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => !disabled && onChange(isPlan ? 'acceptEdits' : 'plan')}
          disabled={disabled}
          aria-label={isPlan ? 'Plan mode (read-only)' : 'Apply mode'}
          aria-pressed={isPlan}
          className={cn(
            'flex h-8 items-center gap-1 rounded-full px-2 text-sm font-medium transition-colors',
            'outline-none focus-visible:ring-3 focus-visible:ring-ring/30',
            'disabled:pointer-events-none disabled:opacity-50',
            isPlan
              ? 'bg-accent text-foreground'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground',
          )}
        >
          {/* One fixed icon; only the label + highlight change with state. */}
          <IconMap size={18} stroke={1.5} />
          {isPlan && <span>Plan</span>}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">
        {isPlan ? 'Read-only — plans without editing' : 'Applies edits automatically — click for Plan'}
      </TooltipContent>
    </Tooltip>
  )
}
