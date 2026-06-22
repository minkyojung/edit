import type { ReactNode } from 'react'
import { ChevronDownIcon } from 'lucide-react'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'

/** One row in an assistant turn's activity stream — a thinking pill, a tool
 * call, etc. Every such row shares this exact shape so the transcript reads as
 * a single consistent column instead of a patchwork of look-alikes: a context
 * icon, a label, an optional truncated preview, an optional trailing marker
 * (spinner / error), and an optional expandable detail.
 *
 * Built straight on Collapsible — NOT the Reasoning / Tool AI-element wrappers —
 * precisely so thinking and tool rows are literally the same component rather
 * than two primitives whose icon sizes, text tones, and spacing drift apart.
 *
 * Hover surfaces a full-row background highlight (no text-colour change); the
 * `-mx-2 px-2` keeps the row content flush-left with the prose answer while
 * letting that highlight breathe past the text on both sides. The named
 * `group/row` keeps its data-state variants from colliding with an enclosing
 * ProcessGroup's `group/process`. */
export function ActivityRow({
  icon,
  label,
  accessory,
  preview,
  trailing,
  detail,
  defaultOpen = false,
}: {
  icon: ReactNode
  label: ReactNode
  /** Inline element shown right after the label (e.g. a file chip). Sits
   * left, next to the label — unlike `trailing`, which is right-aligned. */
  accessory?: ReactNode
  /** Dim one-line preview shown while collapsed (hidden once expanded). */
  preview?: string
  /** Right-aligned status marker (spinner / alert / action button). */
  trailing?: ReactNode
  /** Expandable body. When omitted the row is a static, non-clickable line. */
  detail?: ReactNode
  defaultOpen?: boolean
}) {
  const hasDetail = detail != null
  return (
    <Collapsible
      defaultOpen={defaultOpen}
      disabled={!hasDetail}
      className="group/row my-1 text-[15px]"
    >
      <CollapsibleTrigger
        className={cn(
          '-mx-2 flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-muted-foreground',
          hasDetail && 'cursor-pointer hover:bg-muted/50',
        )}
      >
        <span className="shrink-0">{icon}</span>
        {/* With a preview or accessory the label keeps its natural width (those
            carry the variable-length content); a bare tool row lets the label
            itself flex and truncate so a long name ellipses, not overflows. */}
        <span className={cn('truncate', preview || accessory ? 'shrink-0' : 'min-w-0 flex-1')}>
          {label}
        </span>
        {accessory && (
          <span className="flex min-w-0 shrink items-center gap-1.5">{accessory}</span>
        )}
        {preview && (
          <span className="min-w-0 flex-1 truncate text-muted-foreground/50 group-data-[state=open]/row:hidden">
            {preview}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2 pl-2">
          {trailing}
          {hasDetail && (
            <ChevronDownIcon className="size-3.5 transition-transform group-data-[state=open]/row:rotate-180" />
          )}
        </span>
      </CollapsibleTrigger>
      {hasDetail && (
        <CollapsibleContent className="space-y-2 pt-1 pb-1 text-muted-foreground data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=open]:animate-in">
          {detail}
        </CollapsibleContent>
      )}
    </Collapsible>
  )
}
