import type { ReactNode } from 'react'
import type { MessagePart, ToolPart as ToolPartType } from '@/chat/types'
import { TextPart } from '@/chat/parts/TextPart'
import { ToolPart } from '@/chat/parts/ToolPart'
import { ThinkingPill } from '@/chat/parts/ReasoningPart'
import { ProcessGroup } from '@/chat/parts/ProcessGroup'
import { QuestionActivity } from '@/chat/parts/QuestionActivity'
import { isProposeEditTool } from '@/chat/parts/proposeChangeTool'
import { InlineSuggestion } from '@/chat/suggestions/InlineSuggestion'
import { usePendingChangesStore } from '@/state/pendingChangesStore'

/** Walks an assistant turn's timeline and reshapes it for rendering:
 *  - reasoning + non-edit tool calls form the turn's "process". They render as
 *    `ActivityRow`s in timeline order, all tucked under one collapsed-by-default
 *    `ProcessGroup` summary at the top ("N tool calls, M messages") so the
 *    transcript stays clean. Consecutive reasoning fragments merge into one pill
 *    (Anthropic re-opens the thinking block between tool rounds).
 *  - text parts render below the group as the answer body — the white primary
 *    content, the focus of the turn.
 *  - edit-tool parts (propose_edit / write / multi_edit) render as expanded
 *    edit rows (ActivityRow header + diff) at the very end, kept OUT of the
 *    collapsed group so the proposed change stays visible for review.
 * step-start parts are no-ops (sidecar never emits them today). */
export function PartList({
  parts,
  isStreaming,
  hideText = false,
}: {
  parts: MessagePart[]
  isStreaming: boolean
  /** Suppress text parts — used for a parked plan turn, whose plan lives in
   * the approval card, so the (often redundant) answer text isn't shown twice. */
  hideText?: boolean
}) {
  // Subscribed so the duplicate-shell filter below re-evaluates as proposals
  // land in / leave the store.
  const changesById = usePendingChangesStore((s) => s.byId)

  const processRows: ReactNode[] = []
  const textNodes: ReactNode[] = []
  const editParts: ToolPartType[] = []
  const questionParts: ToolPartType[] = []
  let toolCount = 0
  let messageCount = 0

  // Buffer consecutive reasoning fragments and flush them as one pill the
  // moment a non-reasoning row (tool / text) or the end of the timeline is
  // reached.
  let reasoningBuf: string[] = []
  let reasoningKey: string | null = null
  const flushReasoning = () => {
    if (reasoningBuf.length === 0) return
    processRows.push(
      <ThinkingPill
        key={`reasoning-${reasoningKey}`}
        content={reasoningBuf.join('\n\n')}
        isStreaming={isStreaming}
      />,
    )
    messageCount++
    reasoningBuf = []
    reasoningKey = null
  }

  for (const part of parts) {
    switch (part.type) {
      case 'reasoning':
        if (part.text) {
          if (reasoningKey === null) reasoningKey = part.id
          reasoningBuf.push(part.text)
        }
        break
      case 'tool':
        flushReasoning()
        if (part.toolName === 'AskUserQuestion') {
          // Interactive Q&A — render visibly as its own row, not buried in the
          // collapsed process group, and don't count it as a generic tool call.
          questionParts.push(part)
        } else if (isProposeEditTool(part.toolName)) {
          editParts.push(part)
        } else {
          processRows.push(<ToolPart key={part.id} part={part} />)
          toolCount++
        }
        break
      case 'text':
        flushReasoning()
        if (!hideText) {
          textNodes.push(<TextPart key={part.id} part={part} isStreaming={isStreaming} />)
        }
        break
      case 'step-start':
        break
    }
  }
  flushReasoning()

  // De-dupe edit rows. A turn that creates a note AND edits it fires two
  // proposals for the same file; only one resolves to a live store change
  // (the other is dropped → a non-actionable read-only "shell"). When a live
  // edit exists for a file, hide the shells for that same file so the user
  // sees one actionable row instead of two identical-looking ones. A lone
  // shell (no live sibling) still renders so past edits stay visible.
  const isLiveEdit = (p: ToolPartType) => !!(p.pendingId && changesById[p.pendingId])
  const liveFileKeys = new Set(editParts.filter(isLiveEdit).map(editFileKey))
  const visibleEdits = editParts.filter(
    (p) => isLiveEdit(p) || !liveFileKeys.has(editFileKey(p)),
  )

  return (
    <>
      {processRows.length > 0 && (
        <ProcessGroup summary={summarizeProcess(toolCount, messageCount)}>
          {processRows}
        </ProcessGroup>
      )}
      {textNodes}
      {questionParts.map((part) => (
        <QuestionActivity key={part.id} part={part} />
      ))}
      {visibleEdits.map((part) => (
        <InlineSuggestion key={part.id} part={part} />
      ))}
    </>
  )
}

/** Group key for de-duping edit rows: the target file's name (both the live
 * write and the dropped edit carry the same file_path). Falls back to the
 * part id so a path-less part is never collapsed into another. */
function editFileKey(part: ToolPartType): string {
  const fp = (part.input as { file_path?: string } | null | undefined)?.file_path
  if (!fp) return part.id
  const idx = Math.max(fp.lastIndexOf('/'), fp.lastIndexOf('\\'))
  return idx >= 0 ? fp.slice(idx + 1) : fp
}

/** "N tool calls, M messages" — counts only what the collapsed group hides
 * (non-edit tool rows + thinking pills); edits live outside it. */
function summarizeProcess(toolCount: number, messageCount: number): string {
  const segs: string[] = []
  if (toolCount > 0) segs.push(`${toolCount} tool call${toolCount === 1 ? '' : 's'}`)
  if (messageCount > 0) segs.push(`${messageCount} message${messageCount === 1 ? '' : 's'}`)
  return segs.join(', ')
}
