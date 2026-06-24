// Plan / Edit mode toggle for the PromptInput footer.
//
// Edit (default): the model may propose changes via the propose_* tools.
// Plan: read-only — the turn runs under permissionMode 'plan' and the
// propose_* relays + Bash are dropped, so the model explores with
// Read/Glob/Grep and writes a plan instead of editing. Disabled while a
// turn streams (switching mid-flight wouldn't apply until the next send).

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
          onClick={() => !disabled && onChange(isPlan ? 'edit' : 'plan')}
          disabled={disabled}
          aria-label={isPlan ? 'Plan mode (read-only)' : 'Edit mode'}
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
          {/* One fixed icon for both states; only the label + highlight change. */}
          <IconMap size={18} stroke={1.5} />
          {isPlan && <span>Plan</span>}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">
        {isPlan ? 'Read-only — plans without editing' : 'Can propose edits'}
      </TooltipContent>
    </Tooltip>
  )
}
