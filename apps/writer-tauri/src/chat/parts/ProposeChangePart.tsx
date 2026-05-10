import { IconMessageCircle, IconPencil, IconQuote } from '@tabler/icons-react'
import type { ToolPart as ToolPartType } from '@/chat/types'
import { InlineCard } from '@/chat/ui/InlineCard'
import { ToolStateBadge } from '@/chat/ui/ToolStateBadge'

/** Domain-aware card for the writer-relay `propose_change` tool. Pulls the
 * meaningful fields out of input (kind/quote/content/rationale) so the
 * user sees the suggestion at a glance rather than raw JSON. */
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
  const kindLabel = isComment ? 'Comment' : `Suggestion${input.suggestionType ? ` · ${input.suggestionType}` : ''}`
  // While input is still streaming the strings may be partial JSON; only
  // show the structured layout once we have the parsed object.
  const ready = part.state !== 'input-streaming'
  const replacement = input.content ?? input.text

  return (
    <InlineCard className="my-1 text-xs">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <HeaderIcon size={12} className="shrink-0 text-muted-foreground" />
        <span className="font-medium text-foreground">{kindLabel}</span>
        <span className="ml-auto">
          <ToolStateBadge state={part.state} />
        </span>
      </div>
      {!ready ? (
        <div className="px-3 py-1.5 text-muted-foreground italic">preparing…</div>
      ) : (
        <div className="space-y-1.5 px-3 py-2">
          {input.quote && (
            <div className="flex gap-1.5">
              <IconQuote size={11} className="mt-0.5 shrink-0 text-muted-foreground" />
              <span className="line-through text-muted-foreground/80">{input.quote}</span>
            </div>
          )}
          {!isComment && replacement && (
            <div className="pl-[18px] text-foreground">→ {replacement}</div>
          )}
          {isComment && replacement && <div className="pl-[18px] text-foreground">{replacement}</div>}
          {input.rationale && (
            <div className="border-t border-border pt-1.5 mt-1.5 text-muted-foreground">
              {input.rationale}
            </div>
          )}
        </div>
      )}
    </InlineCard>
  )
}
