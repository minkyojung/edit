import { IconChevronDown, IconMessageCircle, IconPencil, IconQuote } from '@tabler/icons-react'
import type { ToolPart as ToolPartType } from '@/chat/types'
import { Tool, ToolContent } from '@/components/ai-elements/tool'
import { CollapsibleTrigger } from '@/components/ui/collapsible'
import { ToolStateBadge } from '@/chat/ui/ToolStateBadge'
import { humanizeToolCall } from '@/chat/humanizers'

/** Domain-aware card for the writer-relay `propose_change` tool. Pulls the
 * meaningful fields out of input (kind/quote/content/rationale) so the
 * user sees the suggestion at a glance rather than raw JSON.
 *
 * Built on AI Elements `Tool` (Collapsible wrapper) so the propose_change
 * card lines up visually with every other tool call in the turn. The
 * default state is open — a fresh proposal is the whole reason the user
 * is reading the chat, so we don't make them click to see it. The header
 * keeps our domain icons (pencil / message-circle) instead of the generic
 * wrench `ToolHeader` would force, and our existing `ToolStateBadge`
 * preserves the preparing/running/done/error labels callers already
 * recognize. */
export function ProposeChangePart({ part }: { part: ToolPartType }) {
  const input = (part.input ?? {}) as {
    kind?: 'suggestion' | 'comment'
    suggestionType?: 'insert' | 'delete' | 'replace'
    quote?: string
    content?: string
    text?: string
    rationale?: string
  }
  const isComment = input.kind === 'comment'
  const HeaderIcon = isComment ? IconMessageCircle : IconPencil
  // Header label runs through the shared humanizer so propose_change
  // cards read the same way the activity line did one beat ago —
  // "Replace 'X' → 'Y'" not "Suggested edit · replace".
  const { label: kindLabel } = humanizeToolCall(part.toolName, input)
  // While input is still streaming the strings may be partial JSON; only
  // show the structured layout once we have the parsed object.
  const ready = part.state !== 'input-streaming'
  const replacement = input.content ?? input.text

  return (
    <Tool defaultOpen className="my-2 text-xs">
      <CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-2 p-3 text-left">
        <HeaderIcon size={12} className="shrink-0 text-muted-foreground" />
        <span className="font-medium text-foreground">{kindLabel}</span>
        <span className="ml-auto flex items-center gap-2">
          <ToolStateBadge state={part.state} />
          <IconChevronDown
            size={12}
            className="shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180"
          />
        </span>
      </CollapsibleTrigger>
      <ToolContent className="!p-3 !pt-0">
        {!ready ? (
          <div className="text-muted-foreground italic">preparing…</div>
        ) : (
          <div className="space-y-1.5">
            {input.quote && (
              <div className="flex gap-1.5">
                <IconQuote size={11} className="mt-0.5 shrink-0 text-muted-foreground" />
                <span className="line-through text-muted-foreground/80">{input.quote}</span>
              </div>
            )}
            {!isComment && replacement && (
              <div className="pl-4 text-foreground">→ {replacement}</div>
            )}
            {isComment && replacement && (
              <div className="pl-4 text-foreground">{replacement}</div>
            )}
            {input.rationale && (
              <div className="pt-1.5 text-muted-foreground">{input.rationale}</div>
            )}
          </div>
        )}
      </ToolContent>
    </Tool>
  )
}
