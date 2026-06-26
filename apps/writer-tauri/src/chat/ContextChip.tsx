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
  /** When true, the X floats over the chip's right edge on hover (like the
   * chat session tabs) instead of taking inline width — so the chip hugs its
   * label. A right-edge fade keeps the X legible over the text. */
  overlayRemove?: boolean
}

export function ContextChip({
  icon: Icon,
  label,
  tooltip,
  onRemove,
  removeLabel = 'Remove',
  overlayRemove = false,
}: ContextChipProps) {
  const chip = (
    <span
      className={cn(
        'group/chip inline-flex h-7 w-fit max-w-[220px] shrink-0 items-center gap-1.5',
        // bg-background (not bg-muted) so the chip reads as a distinct inset
        // against the composer's bg-muted body — contrast carries it, no border.
        'rounded-md bg-background text-callout text-foreground/80',
        // Overlay mode hugs the label (symmetric padding, X floats); inline
        // mode reserves space on the right for the X button.
        overlayRemove ? 'relative px-2.5' : 'pl-2.5 pr-1.5',
      )}
    >
      <Icon size={14} stroke={1.75} className="shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate font-medium">{label}</span>
      {onRemove && !overlayRemove && (
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
      {onRemove && overlayRemove && (
        <>
          {/* Right-edge fade so the floating X stays legible over the label. */}
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 right-0 w-8 rounded-r-md bg-gradient-to-l from-background from-50% to-transparent opacity-0 transition-opacity group-hover/chip:opacity-100"
          />
          <button
            type="button"
            onMouseDown={(e) => {
              e.preventDefault()
              onRemove()
            }}
            aria-label={removeLabel}
            className={cn(
              'absolute right-1 flex size-4 items-center justify-center rounded-full',
              'bg-muted-foreground/40 text-foreground opacity-0 transition group-hover/chip:opacity-100',
              'hover:bg-muted-foreground/60 dark:bg-foreground dark:text-background dark:hover:bg-foreground/90',
              'outline-none focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/40',
            )}
          >
            <IconX size={9} stroke={2.5} />
          </button>
        </>
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
