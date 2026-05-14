// View-layer model for AI inline suggestions surfaced in chat.
//
// Derived from `ToolPart` (see chat/types.ts) at render time — the
// underlying storage (MessagePart in Y.Doc) is untouched. Adding new
// inline-suggestion tool kinds means extending `SuggestionKind` and the
// adapter; the list/row/detail components stay generic.

import type { MessagePart } from '@/chat/types'

export type SuggestionKind =
  | 'comment'
  | 'replace'
  | 'insert'
  | 'delete'

/** Lifecycle of a single suggestion from the user's point of view.
 *
 * - `streaming`  — tool input is still arriving; no diff yet.
 * - `pending`    — input decoded, mark stamped, awaiting accept/reject.
 * - `accepted`   — user accepted; mark applied to the doc.
 * - `rejected`   — user rejected; mark removed.
 * - `error`      — applyProposal failed (e.g. quote not found in doc).
 *
 * The truth lives on the editor mark; this is a rendering snapshot. */
export type SuggestionState =
  | 'streaming'
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'error'

export interface Suggestion {
  /** Stable id — reuses the ToolPart id so React keys stay consistent
   * across streaming updates. */
  id: string
  toolCallId: string
  kind: SuggestionKind
  /** Original text being commented on / replaced / deleted. Absent for
   * pure inserts (no anchor text). */
  quote?: string
  /** Replacement text (for replace/insert) or comment body (for comment).
   * Absent for `delete`. */
  content?: string
  /** Optional explanation from the model. */
  rationale?: string
  state: SuggestionState
  /** Editor mark id stamped by applyProposal. Connects this row to the
   * inline mark in the doc — Phase 2 uses it for bi-directional
   * highlight + accept/reject routing. */
  markId?: string
  /** Failure detail when `state === 'error'`. */
  errorText?: string
  ts: number
}

/** A run of contiguous suggestions in an assistant turn's timeline. Rendered
 * as one `SuggestionList`; non-suggestion parts (text, reasoning, other
 * tools) break the run and render between groups. */
export interface SuggestionGroup {
  type: 'suggestion-group'
  id: string                   // first suggestion's id, used as React key
  suggestions: Suggestion[]
}

/** Result of grouping an assistant turn's parts for rendering. Each item is
 * either a suggestion group or a passthrough part to render with the
 * existing per-type components. */
export type RenderItem =
  | SuggestionGroup
  | { type: 'part'; part: MessagePart }
