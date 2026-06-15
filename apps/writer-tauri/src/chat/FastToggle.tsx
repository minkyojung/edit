// Fast-mode toggle for the PromptInput footer.
//
// Fast mode = faster output without downgrading the model. Only rendered for
// models that support it (modelSupportsFastMode — Opus). Two layers:
//   - `value` is the user's REQUEST (persisted on ThreadMeta.fastMode).
//   - `state` is the SDK's ACTUAL state from the last turn. `cooldown` means a
//     rate limit forced fast mode off even though it was requested; we surface
//     that distinctly (amber) so the user knows why it isn't active, while
//     keeping their preference on.
// Disabled while a turn streams (a mid-flight switch wouldn't apply until the
// next send).

import { IconBolt } from '@tabler/icons-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { FastModeState } from '@/chat/types'
import { cn } from '@/lib/utils'

interface Props {
  value: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  /** Actual fast-mode state the SDK last reported; `cooldown` = rate-limited. */
  state?: FastModeState
}

export function FastToggle({ value, onChange, disabled, state }: Props) {
  const cooldown = value && state === 'cooldown'
  const tip = cooldown
    ? 'Rate-limited — fast mode paused, resumes automatically'
    : value
      ? 'Fast mode on — faster output'
      : 'Fast mode — faster output'
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => !disabled && onChange(!value)}
          disabled={disabled}
          aria-label={value ? 'Fast mode on' : 'Fast mode off'}
          aria-pressed={value}
          className={cn(
            'flex h-8 items-center gap-1 rounded-full px-2 text-sm font-medium transition-colors',
            'outline-none focus-visible:ring-3 focus-visible:ring-ring/30',
            'disabled:pointer-events-none disabled:opacity-50',
            cooldown
              ? 'bg-warning/15 text-warning'
              : value
                ? 'bg-accent text-foreground'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground',
          )}
        >
          <IconBolt size={18} stroke={2} />
          {/* Icon-only until toggled on — the label appears only when fast. */}
          {value && <span>Fast</span>}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{tip}</TooltipContent>
    </Tooltip>
  )
}
