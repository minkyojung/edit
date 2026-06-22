import type { ReactNode } from 'react'
import { ChevronRightIcon } from 'lucide-react'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'

/** Collapses an assistant turn's whole "process" — its thinking pills and
 * tool calls — under one summary line at the top of the turn ("N tool calls,
 * M messages"), so the transcript stays clean and the prose answer below is
 * the focus. Collapsed by default; expand to reveal every individual row.
 *
 * Named `group/process` so its open-state chevron rotation doesn't collide
 * with the `group/row` data-state variants of the ActivityRows nested inside. */
export function ProcessGroup({
  summary,
  children,
}: {
  summary: string
  children: ReactNode
}) {
  return (
    <Collapsible defaultOpen={false} className="group/process my-2">
      <CollapsibleTrigger className="-mx-2 flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-left text-[15px] text-muted-foreground hover:bg-muted/50">
        <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-data-[state=open]/process:rotate-90" />
        <span>{summary}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=open]:animate-in">
        {children}
      </CollapsibleContent>
    </Collapsible>
  )
}
