import type { ReactNode } from 'react'
import { ChevronRightIcon } from 'lucide-react'
import { IconRobot } from '@tabler/icons-react'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'

/** Groups the orchestrator's delegated subagents (Task tool calls) into one
 * visible "parallel lanes" block.
 *
 * Unlike ProcessGroup — which folds the main agent's OWN tools/thinking away
 * once the turn settles — this stays OPEN by default. Fan-out is the point of
 * the turn, so the lanes should remain in sight (each row carries its live
 * heartbeat), with the left rule reading them as branches under the
 * orchestrator. It's still collapsible for when the user wants them out of the
 * way.
 *
 * Named `group/sub` so its chevron rotation doesn't collide with the
 * `group/process` and `group/row` data-state variants nested around it. */
export function SubagentGroup({
  count,
  children,
}: {
  count: number
  children: ReactNode
}) {
  const label = `${count} subagent${count === 1 ? '' : 's'}`
  return (
    <Collapsible defaultOpen className="group/sub my-2">
      <CollapsibleTrigger className="-mx-2 flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-left text-[15px] text-muted-foreground hover:bg-muted/50">
        <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-data-[state=open]/sub:rotate-90" />
        <IconRobot size={14} className="shrink-0" />
        <span className="min-w-0 truncate">{label}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=open]:animate-in">
        <div className="ml-1.5 border-l border-border/50 pl-2.5">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  )
}
