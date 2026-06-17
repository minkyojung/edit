// One chip for every piece of context attached to a chat turn — the file
// you're viewing, the passage you've selected, (later) @-mentioned files.
// A single component keeps them visually identical: a light inset pill
// (bg-background on the composer's bg-muted), a leading glyph, a truncating
// label, and an X that reveals on hover. shrink-0 so a row of them scrolls
// sideways rather than compressing.
import type { ComponentType, ReactNode } from 'react'
import { IconX } from '@tabler/icons-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

interface IconProps {
  size?: number
  stroke?: number
  className?: string
}

interface ContextChipProps {
  /** Leading glyph — a tabler icon component (file kind, quote, …). */
  icon: ComponentType<IconProps>
  /** Single-line label; truncates with ellipsis when it overflows. */
  label: string
  /** Hover tooltip — full path, selected text, etc. Omit for no tooltip. */
  tooltip?: ReactNode
  /** Detach handler. Omit to render a non-removable chip (no X). */
  onRemove?: () => void
  /** Accessible label for the X button. */
  removeLabel?: string
}

export function ContextChip({
  icon: Icon,
  label,
  tooltip,
  onRemove,
  removeLabel = 'Remove',
}: ContextChipProps) {
  const chip = (
    <span
      className={cn(
        'group/chip inline-flex h-7 w-fit max-w-[220px] shrink-0 items-center gap-1.5',
        // bg-background (not bg-muted) so the chip reads as a distinct inset
        // against the composer's bg-muted body — contrast carries it, no border.
        'rounded-md bg-background pl-2.5 pr-1.5 text-[13px] text-foreground/80',
      )}
    >
      <Icon size={14} stroke={1.75} className="shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate font-medium">{label}</span>
      {onRemove && (
        <button
          type="button"
          onMouseDown={(e) => {
            // mousedown so the composer textarea keeps focus.
            e.preventDefault()
            onRemove()
          }}
          aria-label={removeLabel}
          className={cn(
            'shrink-0 rounded p-0.5 text-muted-foreground outline-none transition-opacity',
            'opacity-0 group-hover/chip:opacity-100 focus-visible:opacity-100',
            'hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40',
          )}
        >
          <IconX size={12} stroke={2} />
        </button>
      )}
    </span>
  )
  if (!tooltip) return chip
  return (
    <Tooltip>
      <TooltipTrigger asChild>{chip}</TooltipTrigger>
      <TooltipContent side="top" align="start" className="max-w-sm whitespace-pre-wrap text-left">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
}
