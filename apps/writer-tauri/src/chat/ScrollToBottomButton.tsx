import { IconChevronDown } from '@tabler/icons-react'
import { cn } from '@/lib/utils'

/** Floating "jump to latest" affordance. Sits inside the PromptInput's
 * wrapper as an absolute sibling — `bottom-full` anchors it to the wrapper's
 * top edge, so the button rides up naturally as the input grows. Visibility
 * is fully driven by the parent (`pinned` + non-empty transcript). */
export function ScrollToBottomButton({
  visible,
  onClick,
}: {
  visible: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Scroll to latest"
      tabIndex={visible ? 0 : -1}
      className={cn(
        'absolute left-1/2 bottom-full z-10 mb-2 -translate-x-1/2',
        'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5',
        'border border-border/40 bg-muted text-footnote font-medium text-muted-foreground shadow-sm',
        'transition-opacity duration-150',
        'hover:bg-accent hover:text-foreground',
        'outline-none focus-visible:ring-3 focus-visible:ring-ring/30',
        visible ? 'opacity-100' : 'pointer-events-none opacity-0',
      )}
    >
      <IconChevronDown size={14} stroke={2} />
      <span>Scroll to bottom</span>
    </button>
  )
}
