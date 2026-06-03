import type {
  MessagePart,
  ReasoningPart,
  ToolPart,
  TextPart as TextPartType,
} from '@/chat/types'
import { TextPart } from '@/chat/parts/TextPart'
import { ProcessChain } from '@/chat/parts/ProcessChain'
import { isProposeEditTool } from '@/chat/parts/proposeChangeTool'
import { InlineSuggestion } from '@/chat/suggestions/InlineSuggestion'

/** Walks an assistant turn's timeline and reshapes it for rendering.
 * Three buckets:
 *  - "process" parts (reasoning + non-edit tool calls) feed a single
 *    ProcessChain at the top — one collapsible whose inner rows expand.
 *  - text parts render in order below as the body.
 *  - edit-tool parts (propose_edit / write / multi_edit) render as
 *    inline suggestion cards under the answer, each wired to its
 *    PendingChange for Keep / Reject. They are pulled out of the
 *    ProcessChain so the decision happens in the answer, not buried in
 *    the "Worked on the document" receipt.
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
  const processParts: Array<ReasoningPart | ToolPart> = []
  const textParts: TextPartType[] = []
  const editParts: ToolPart[] = []
  for (const part of parts) {
    switch (part.type) {
      case 'reasoning':
        processParts.push(part)
        break
      case 'tool':
        if (isProposeEditTool(part.toolName)) editParts.push(part)
        else processParts.push(part)
        break
      case 'text':
        textParts.push(part)
        break
      case 'step-start':
        break
    }
  }

  return (
    <>
      {processParts.length > 0 && (
        <ProcessChain parts={processParts} isStreaming={isStreaming} />
      )}
      {!hideText &&
        textParts.map((part) => (
          <TextPart key={part.id} part={part} isStreaming={isStreaming} />
        ))}
      {editParts.map((part) => (
        <InlineSuggestion key={part.id} part={part} />
      ))}
    </>
  )
}
