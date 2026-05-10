import React from 'react'
import { IconChevronRight, IconTool } from '@tabler/icons-react'
import type { ToolPart as ToolPartType } from '@/chat/types'
import { InlineCard } from '@/chat/ui/InlineCard'
import { ToolStateBadge } from '@/chat/ui/ToolStateBadge'
import { KeyValueBlock } from '@/chat/ui/KeyValueBlock'

/** Tool invocation card. Mirrors the AI Elements `<Tool>` family — a
 * collapsible wrapper with a header (tool name + state badge) and a
 * content section showing input and (when available) output. */
export function ToolPart({ part }: { part: ToolPartType }) {
  const [open, setOpen] = React.useState(false)
  return (
    <InlineCard className="my-1 text-xs">
      <details
        open={open}
        onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
      >
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 select-none">
          <IconChevronRight
            size={12}
            className="shrink-0 transition-transform"
            style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}
          />
          <IconTool size={12} className="shrink-0 text-muted-foreground" />
          <span className="font-mono">{part.toolName}</span>
          <span className="ml-auto">
            <ToolStateBadge state={part.state} />
          </span>
        </summary>
        <div className="space-y-2 px-3 pb-2 pt-1">
          <KeyValueBlock label="input" value={part.input} />
          {(part.state === 'output-available' || part.state === 'output-error') && (
            <KeyValueBlock
              label={part.state === 'output-error' ? 'error' : 'output'}
              value={part.errorText ?? part.output}
            />
          )}
        </div>
      </details>
    </InlineCard>
  )
}
