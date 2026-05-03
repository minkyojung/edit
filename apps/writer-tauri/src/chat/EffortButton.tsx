// Reasoning-effort toggle for the PromptInput footer.
//
// Visual: three concentric circles (target/bullseye) whose rings fade in
// as effort climbs — low fills only the centre, high fills all three.
// Click cycles low → medium → high → low. Disabled while a turn is
// streaming for the same reason ModelSelect is: switching mid-flight
// would mismatch the prompt with the new effort on the next retry.

import {
  CHAT_EFFORTS,
  CHAT_EFFORT_LABELS,
  CHAT_EFFORT_OPACITIES,
  type ChatEffort,
} from '@/chat/types'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

interface Props {
  value: ChatEffort
  onChange: (next: ChatEffort) => void
  disabled?: boolean
}

export function EffortButton({ value, onChange, disabled }: Props) {
  const [inner, middle, outer] = CHAT_EFFORT_OPACITIES[value]

  function cycle() {
    if (disabled) return
    const idx = CHAT_EFFORTS.indexOf(value)
    onChange(CHAT_EFFORTS[(idx + 1) % CHAT_EFFORTS.length])
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={cycle}
          disabled={disabled}
          aria-label={`Reasoning effort: ${CHAT_EFFORT_LABELS[value]}`}
          className={cn(
            'flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground transition-colors',
            'hover:bg-accent hover:text-foreground',
            'disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent',
          )}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.25"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle
              cx="12"
              cy="12"
              r="10"
              opacity={outer}
              style={{ transition: 'opacity 0.15s' }}
            />
            <circle
              cx="12"
              cy="12"
              r="6"
              opacity={middle}
              style={{ transition: 'opacity 0.15s' }}
            />
            <circle
              cx="12"
              cy="12"
              r="2"
              opacity={inner}
              style={{ transition: 'opacity 0.15s' }}
            />
          </svg>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{CHAT_EFFORT_LABELS[value]}</TooltipContent>
    </Tooltip>
  )
}
