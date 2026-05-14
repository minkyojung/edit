import { IconChevronDown, IconTool } from '@tabler/icons-react'
import type { ToolPart as ToolPartType } from '@/chat/types'
import { Tool, ToolContent } from '@/components/ai-elements/tool'
import { CollapsibleTrigger } from '@/components/ui/collapsible'
import { ToolStateBadge } from '@/chat/ui/ToolStateBadge'
import { KeyValueBlock } from '@/chat/ui/KeyValueBlock'
import { humanizeToolCall } from '@/chat/humanizers'

/** Generic tool invocation card (Read / Bash / Grep / …). Built on AI
 * Elements `Tool` so it lines up with `ProposeChangePart`; the body is
 * collapsed by default because generic tool I/O is rarely the thing the
 * user actually wants to read — it's there for inspection, not the
 * star of the turn. */
export function ToolPart({ part }: { part: ToolPartType }) {
  const { label } = humanizeToolCall(part.toolName, part.input, part.output)
  return (
    <Tool className="my-2 text-xs">
      <CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-2 p-3 text-left">
        <IconTool size={12} className="shrink-0 text-muted-foreground" />
        <span className="text-foreground">{label}</span>
        <span className="ml-auto flex items-center gap-2">
          <ToolStateBadge state={part.state} />
          <IconChevronDown
            size={12}
            className="shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180"
          />
        </span>
      </CollapsibleTrigger>
      <ToolContent className="!p-3 !pt-0 !space-y-2">
        <KeyValueBlock label="input" value={part.input} />
        {(part.state === 'output-available' || part.state === 'output-error') && (
          <KeyValueBlock
            label={part.state === 'output-error' ? 'error' : 'output'}
            value={part.errorText ?? part.output}
          />
        )}
      </ToolContent>
    </Tool>
  )
}
