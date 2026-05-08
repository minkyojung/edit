// Reasoning-effort toggle for the PromptInput footer.
//
// Visual: three concentric circles (target/bullseye) whose rings fade in
// as effort climbs — low fills only the centre, high fills all three.
// Click cycles low → medium → high → low. Disabled while a turn is
// streaming for the same reason ModelSelect is: switching mid-flight
// would mismatch the prompt with the new effort on the next retry.

import { useRef, useState } from 'react'
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
  // Controlled tooltip so a click cycles the value without dismissing the
  // popup (Radix's default behavior is to close on pointerdown). We keep
  // it open while the pointer is over the trigger; the label re-renders
  // automatically as `value` advances.
  const [open, setOpen] = useState(false)
  const isOverRef = useRef(false)

  function cycle() {
    if (disabled) return
    const idx = CHAT_EFFORTS.indexOf(value)
    onChange(CHAT_EFFORTS[(idx + 1) % CHAT_EFFORTS.length])
    setOpen(true)
  }

  return (
    <Tooltip
      open={open}
      onOpenChange={(next) => {
        // Ignore Radix's mousedown-close while the pointer is still over
        // the trigger — otherwise clicking flickers the tooltip closed.
        if (!next && isOverRef.current) return
        setOpen(next)
      }}
    >
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={cycle}
          onPointerEnter={() => {
            isOverRef.current = true
            if (!disabled) setOpen(true)
          }}
          onPointerLeave={() => {
            isOverRef.current = false
            setOpen(false)
          }}
          onFocus={() => {
            if (!disabled) setOpen(true)
          }}
          onBlur={() => setOpen(false)}
          disabled={disabled}
          aria-label={`Reasoning effort: ${CHAT_EFFORT_LABELS[value]}`}
          className={cn(
            'flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors',
            'outline-none focus-visible:ring-3 focus-visible:ring-ring/30',
            'hover:bg-accent hover:text-foreground',
            'disabled:pointer-events-none disabled:opacity-50',
          )}
        >
          <svg
            width="20"
            height="20"
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
