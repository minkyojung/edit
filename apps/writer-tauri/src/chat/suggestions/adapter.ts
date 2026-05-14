// Adapter from storage-layer ToolPart → view-layer Suggestion.
//
// Run at render time inside PartList. Keeping the conversion in one
// place means new inline-suggestion tools only need a new branch here;
// SuggestionList / SuggestionRow / SuggestionDetail stay generic.

import type { MessagePart, ToolPart } from '@/chat/types'
import { PROPOSE_CHANGE_TOOL } from '@/chat/parts/proposeChangeTool'
import type {
  RenderItem,
  Suggestion,
  SuggestionGroup,
  SuggestionKind,
  SuggestionState,
} from './types'

interface ProposeChangeInput {
  kind?: 'suggestion' | 'comment'
  suggestionType?: 'insert' | 'delete' | 'replace'
  quote?: string
  content?: string
  text?: string
  rationale?: string
}

interface ProposeChangeOutput {
  ok?: boolean
  markId?: string
  reason?: string
}

function deriveKind(input: ProposeChangeInput): SuggestionKind {
  if (input.kind === 'comment') return 'comment'
  return input.suggestionType ?? 'replace'
}

function deriveState(part: ToolPart): SuggestionState {
  if (part.state === 'input-streaming') return 'streaming'
  if (part.state === 'output-error') return 'error'
  const output = (part.output ?? {}) as ProposeChangeOutput
  if (part.state === 'output-available') {
    return output.ok === false ? 'error' : 'pending'
  }
  return 'pending'
}

/** True iff this part is an inline-suggestion tool we want to render via
 * the SuggestionList path. Today only `propose_change`; add new tool ids
 * here as they ship. */
export function isSuggestionPart(part: MessagePart): part is ToolPart {
  return part.type === 'tool' && part.toolName === PROPOSE_CHANGE_TOOL
}

export function toSuggestion(part: ToolPart): Suggestion {
  const input = (part.input ?? {}) as ProposeChangeInput
  const output = (part.output ?? {}) as ProposeChangeOutput
  const kind = deriveKind(input)
  return {
    id: part.id,
    toolCallId: part.toolCallId,
    kind,
    quote: input.quote,
    content: input.content ?? input.text,
    rationale: input.rationale,
    state: deriveState(part),
    markId: output.markId,
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
