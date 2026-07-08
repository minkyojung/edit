// Context-usage gauge for the PromptInput footer (left of ModelSelect).
//
// A donut ring whose arc fills with the fraction of the model's context
// window in use. Hovering opens the breakdown popover. Styling matches the
// neighbouring EffortButton (size-7 button, 16px svg). The arc turns amber
// past the auto-compaction threshold (real value in STEP 3; a fixed 0.8
// until then) to signal that the conversation is about to be summarised.

import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import type { ContextSnapshot } from '@/chat/types'
import { ContextUsagePopover } from './ContextUsagePopover'
import { cn } from '@/lib/utils'

const WARN_FALLBACK = 0.8
// Ring geometry inside the 24×24 viewBox: r=8 leaves a 3px stroke clear of
// the edge. Circumference drives the stroke-dasharray that draws the arc.
const R = 8
const C = 2 * Math.PI * R

interface Props {
  snapshot?: ContextSnapshot | null
}

export function ContextGauge({ snapshot }: Props) {
  const usedFrac =
    snapshot && snapshot.maxTokens > 0
      ? Math.min(1, Math.max(0, snapshot.totalTokens / snapshot.maxTokens))
      : 0
  const threshold = snapshot?.autoCompactThreshold ?? WARN_FALLBACK
  const warn = usedFrac >= threshold

  return (
    <HoverCard openDelay={120} closeDelay={80}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          aria-label="Context usage"
          className={cn(
            'flex size-8 items-center justify-center rounded-full transition-colors',
            'outline-none focus-visible:ring-3 focus-visible:ring-ring/30 hover:bg-accent',
            warn ? 'text-warning' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            {/* Track */}
            <circle cx="12" cy="12" r={R} stroke="currentColor" strokeWidth="3" opacity="0.2" />
            {/* Progress arc — starts at 12 o'clock (rotate -90). */}
            <circle
              cx="12"
              cy="12"
              r={R}
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray={`${usedFrac * C} ${C}`}
              transform="rotate(-90 12 12)"
              style={{ transition: 'stroke-dasharray 0.3s ease' }}
            />
          </svg>
        </button>
      </HoverCardTrigger>
      <HoverCardContent side="top" align="end">
        <ContextUsagePopover snapshot={snapshot ?? null} />
      </HoverCardContent>
    </HoverCard>
  )
}
