import type { ReactNode } from 'react'
import { ChevronRightIcon } from 'lucide-react'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'

/** Groups an assistant turn's "process" — thinking pills, tool calls, agents,
 * the plan.
 *
 * While the turn streams the rows are shown openly (no header) so they stack in
 * live — the running timer lives at the bottom of the turn, not here. Once the
 * turn settles, the rows fold into a "N tool calls, M messages" summary so the
 * prose answer is the focus; clicking re-expands them.
 *
 * Named `group/process` so its open-state chevron rotation doesn't collide with
 * the `group/row` data-state variants of the ActivityRows nested inside. */
export function ProcessGroup({
  summary,
  isStreaming,
  children,
}: {
  summary: string
  isStreaming: boolean
  children: ReactNode
}) {
  if (isStreaming) {
    return <div className="my-2">{children}</div>
  }

  return (
    <Collapsible defaultOpen={false} className="group/process my-2">
      <CollapsibleTrigger className="-mx-2 flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-left text-[15px] text-muted-foreground hover:bg-muted/50">
        <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-data-[state=open]/process:rotate-90" />
        <span className="min-w-0 truncate">{summary}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=open]:animate-in">
        {children}
      </CollapsibleContent>
    </Collapsible>
  )
}
