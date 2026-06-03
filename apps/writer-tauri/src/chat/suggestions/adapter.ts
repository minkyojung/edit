// Adapter from storage-layer ToolPart → view-layer Suggestion.
//
// Run at render time inside PartList. Keeping the conversion in one
// place means new inline-edit tools only need a new branch here;
// SuggestionList / SuggestionRow / SuggestionDetail stay generic.

import type { MessagePart, ToolPart } from '@/chat/types'
import { EDIT_DOCUMENT_TOOL } from '@/chat/parts/proposeChangeTool'
import type {
  RenderItem,
  Suggestion,
  SuggestionGroup,
  SuggestionState,
} from './types'

interface EditDocumentInput {
  quote?: string
  content?: string
  rationale?: string
}

interface EditDocumentOutput {
  ok?: boolean
  reason?: string
}

function deriveState(part: ToolPart): SuggestionState {
  if (part.state === 'input-streaming') return 'streaming'
  if (part.state === 'output-error') return 'error'
  const output = (part.output ?? {}) as EditDocumentOutput
  if (part.state === 'output-available') {
    return output.ok === false ? 'error' : 'pending'
  }
  return 'pending'
}

/** True iff this part is an inline-edit tool we want to render via
 * the SuggestionList path. Today only `edit_document`; add new tool
 * ids here as they ship. */
export function isSuggestionPart(part: MessagePart): part is ToolPart {
  return part.type === 'tool' && part.toolName === EDIT_DOCUMENT_TOOL
}

export function toSuggestion(part: ToolPart): Suggestion {
  const input = (part.input ?? {}) as EditDocumentInput
  const output = (part.output ?? {}) as EditDocumentOutput
  return {
    id: part.id,
    toolCallId: part.toolCallId,
    // Every edit_document call is a replace under the hood (empty
    // quote = insert, empty content = delete are still expressed as
    // a string-replace operation). Hard-code 'replace' until a
    // future variant needs a distinct kind.
    kind: 'replace',
    quote: input.quote,
    content: input.content,
    rationale: input.rationale,
    state: deriveState(part),
    errorText: part.errorText ?? output.reason,
    ts: part.ts,
  }
}

/** Walk an assistant turn's timeline and collapse contiguous suggestion
 * tool parts into a single group. Other part types (text, reasoning,
 * step-start, non-suggestion tools) pass through unchanged so the
 * existing PartList dispatch keeps working. */
export function groupAssistantParts(parts: MessagePart[]): RenderItem[] {
  const items: RenderItem[] = []
  let pending: Suggestion[] = []

  const flush = () => {
    if (pending.length === 0) return
    const group: SuggestionGroup = {
      type: 'suggestion-group',
      id: pending[0].id,
      suggestions: pending,
    }
    items.push(group)
    pending = []
  }

  for (const part of parts) {
    if (isSuggestionPart(part)) {
      pending.push(toSuggestion(part))
    } else {
      flush()
      items.push({ type: 'part', part })
    }
  }
  flush()
  return items
}
