// Bridges a chat edit-tool part (propose_edit / write / multi_edit) to
// its live PendingChange and renders the inline suggestion card.
//
// The link is `part.pendingId`, stamped onto the part from the
// tool_result text (see streamParser). Two phases:
//   - Live: the store has the change → full card with Keep / Reject,
//     status synced across every surface.
//   - Historical: the change was pruned after a decision (or dropped /
//     still streaming) → no store entry. We fall back to the diff
//     reconstructed from `part.input`, which is permanent in the
//     message, so scrolling back still shows what the edit proposed.

import { useMemo } from 'react'
import type { ToolPart } from '@/chat/types'
import { usePendingChangesStore } from '@/state/pendingChangesStore'
import { DiffBlock } from '@/components/DiffBlock'
import { SuggestionCard } from './SuggestionCard'
import { diffLinesFromToolInput } from './toolInputDiff'

export function InlineSuggestion({ part }: { part: ToolPart }) {
  const change = usePendingChangesStore((s) =>
    part.pendingId ? s.byId[part.pendingId] : undefined,
  )

  // `_system/*` writes (log.md, index.md, …) are host-managed bookkeeping:
  // toPendingChange drops them from the review queue and the host appends the
  // log itself. So don't render their (fallback) diff in the chat — they're
  // not content the user reviews, and showing the auto-log clutters the answer.
  const filePath = (part.input as { file_path?: string } | null)?.file_path
  if (typeof filePath === 'string' && filePath.includes('_system/')) return null

  const fallbackDiff = useMemo(
    () => diffLinesFromToolInput(part.toolName, part.input),
    [part.toolName, part.input],
  )

  // Live store entry — the actionable card.
  if (change) return <SuggestionCard change={change} />

  // No store entry. While the input is still arriving there's nothing
  // to show yet; once it's decoded, render the proposed diff read-only.
  if (fallbackDiff.length === 0) {
    const preparing =
      part.state === 'input-streaming' || part.state === 'input-available'
    if (preparing) {
      return (
        <div className="my-2 text-xs italic text-muted-foreground">
          Preparing edit…
        </div>
      )
    }
    return null
  }

  return (
    <div className="my-2 rounded-md border border-border bg-muted/40 p-2 text-xs">
      <DiffBlock lines={fallbackDiff} />
    </div>
  )
}
