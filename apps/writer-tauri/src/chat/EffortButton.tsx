// Reasoning-effort toggle for the PromptInput footer.
//
// Visual: concentric circles (target/bullseye), one ring per effort level
// the current model supports — so the icon shows three rings for Sonnet/
// Haiku and four for Opus (which unlocks `xhigh`). Rings fill inward-out as
// effort climbs: the lowest level lights only the centre, the highest lights
// them all. Click cycles through the model's levels. Disabled while a turn
// is streaming for the same reason ModelSelect is: switching mid-flight
// would mismatch the prompt with the new effort on the next retry.

import { useRef, useState } from 'react'
import {
  CHAT_EFFORT_LABELS,
  type ChatEffort,
} from '@/chat/types'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

interface Props {
  value: ChatEffort
  /** Levels the current model offers, ascending. Drives both the cycle
   * order and the number of rings drawn. */
  efforts: readonly ChatEffort[]
  onChange: (next: ChatEffort) => void
  disabled?: boolean
}

// Bullseye geometry inside the 24×24 viewBox: rings spread evenly from the
// centre dot (r=2) to the outer edge (r=10), so the outer ring sits in the
// same place regardless of count and only the in-between spacing changes.
function ringRadii(count: number): number[] {
  if (count <= 1) return [2]
  return Array.from({ length: count }, (_, i) => 2 + (i * 8) / (count - 1))
}

export function EffortButton({ value, efforts, onChange, disabled }: Props) {
  // -1 (value not in the list, e.g. mid-clamp) falls back to the centre.
  const index = Math.max(0, efforts.indexOf(value))
  const radii = ringRadii(efforts.length)
  // Controlled tooltip so a click cycles the value without dismissing the
  // popup (Radix's default behavior is to close on pointerdown). We keep
  // it open while the pointer is over the trigger; the label re-renders
  // automatically as `value` advances.
  const [open, setOpen] = useState(false)
  const isOverRef = useRef(false)

  function cycle() {
    if (disabled) return
    const idx = efforts.indexOf(value)
    onChange(efforts[(idx + 1) % efforts.length])
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
            'flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors',
            'outline-none focus-visible:ring-3 focus-visible:ring-ring/30',
            'hover:bg-accent hover:text-foreground',
            'disabled:pointer-events-none disabled:opacity-50',
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
            {radii.map((r, i) => (
              <circle
                key={i}
                cx="12"
                cy="12"
                r={r}
                // A ring is lit once effort reaches its level — rings at or
                // below the selected index are solid, the rest dimmed.
                opacity={i <= index ? 1 : 0.2}
                style={{ transition: 'opacity 0.15s' }}
              />
            ))}
          </svg>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{CHAT_EFFORT_LABELS[value]}</TooltipContent>
    </Tooltip>
  )
}
