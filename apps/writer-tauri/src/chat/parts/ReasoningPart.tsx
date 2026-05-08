import React from 'react'
import { IconChevronRight, IconLoader2 } from '@tabler/icons-react'
import type { ReasoningPart as ReasoningPartType } from '@/chat/types'
import { InlineCard } from '@/chat/ui/InlineCard'

export function ReasoningPart({
  part,
  isStreaming,
}: {
  part: ReasoningPartType
  isStreaming: boolean
}) {
  // Empty-state spinner is owned by the top-level ActivityStatus now —
  // skip rendering until we actually have thoughts to show.
  if (!part.text) return null
  return <ThinkingPanel content={part.text} streamingNoText={isStreaming} />
}

export function ThinkingPanel({
  content,
  streamingNoText,
}: {
  content: string
  streamingNoText: boolean
}) {
  // While the model is mid-stream and hasn't produced any text yet, render an
  // open spinner-style panel so the user can see the chain of thought live.
  // Once text starts flowing (or the turn finished), collapse to a small
  // toggleable capsule so it doesn't dominate the conversation.
  const [open, setOpen] = React.useState(streamingNoText)

  React.useEffect(() => {
    if (streamingNoText) setOpen(true)
    else setOpen(false)
  }, [streamingNoText])

  return (
    <InlineCard className="mb-2 text-xs">
      <details
        open={open}
        onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
      >
        <summary className="flex cursor-pointer items-center gap-2 list-none px-3 py-1.5 text-muted-foreground select-none">
          {streamingNoText ? (
            <IconLoader2 size={12} className="shrink-0 animate-spin" />
          ) : (
            <IconChevronRight
              size={12}
              className="shrink-0 transition-transform"
              style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}
            />
          )}
          <span>{streamingNoText ? 'Thinking…' : 'Thoughts'}</span>
        </summary>
        <div className="px-3 pb-2 pt-1 whitespace-pre-wrap text-muted-foreground/90">
          {content}
        </div>
      </details>
    </InlineCard>
  )
}
