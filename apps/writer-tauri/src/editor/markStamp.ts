// Transaction helpers for the mark-native pending-edit model.
//
// pending edits are represented in the live PM doc by the
// `proofSuggestion` mark (schema in ./schema/proof-marks.ts). These
// helpers are the ONLY place that adds / removes that mark, so the
// `addToHistory: false` discipline (pending materialisation must not
// pollute the user's undo stack) lives in one auditable spot.
//
// They operate on a `Transaction` and return it for chaining — the
// caller owns dispatch. Callers that materialise pending content (the
// inline review plugin's reconcile path) must set
// `tr.setMeta('addToHistory', false)` before dispatch; `stampInsert`
// does NOT set it itself because the same primitive is reused by the
// Keep path (removeMark), which IS a user action and belongs in
// history.

import type { Mark, MarkType, Node as PMNode, Schema } from '@milkdown/kit/prose/model'
import type { Transaction } from '@milkdown/kit/prose/state'

/** Kinds the `proofSuggestion` mark distinguishes for pending edits.
 * Mirrors the schema's `kind` attr (proof-marks.ts). */
export type PendingMarkKind = 'insert' | 'delete' | 'replace'

/** Resolve the `proofSuggestion` MarkType from a live schema. Throws
 * if the schema doesn't register it — that would mean proofSchemaPlugins
 * wasn't wired into this editor, a wiring bug we want loud, not silent. */
export function proofSuggestionType(schema: Schema): MarkType {
  const type = schema.marks.proofSuggestion
  if (!type) {
    throw new Error(
      '[markStamp] schema is missing the proofSuggestion mark — proofSchemaPlugins not registered?',
    )
  }
  return type
}

/** Build a `proofSuggestion` mark of the given kind. `id`/`by` ride
 * the schema's defaults when omitted. */
export function pendingMark(
  schema: Schema,
  kind: PendingMarkKind,
  attrs: { id?: string; by?: string } = {},
): Mark {
  return proofSuggestionType(schema).create({ kind, ...attrs })
}

/** Add a pending mark of `kind` over `[from, to)`. Returns `tr` for
 * chaining. The caller sets `addToHistory` meta as appropriate. */
export function stampPending(
  tr: Transaction,
  schema: Schema,
  from: number,
  to: number,
  kind: PendingMarkKind,
  attrs: { id?: string; by?: string } = {},
): Transaction {
  return tr.addMark(from, to, pendingMark(schema, kind, attrs))
}

/** Remove any `proofSuggestion` mark over `[from, to)` — the Keep path
 * for an insert (the node stays, becomes ordinary body) and the
 * decoration-drop path. Returns `tr` for chaining. */
export function unstampPending(
  tr: Transaction,
  schema: Schema,
  from: number,
  to: number,
): Transaction {
  return tr.removeMark(from, to, proofSuggestionType(schema))
}

/** True iff `node` carries a `proofSuggestion` mark of `kind`. Shared
 * read predicate so the reconcile + strip paths agree on what "pending"
 * means. */
export function hasPendingMark(node: PMNode, kind: PendingMarkKind): boolean {
  return node.marks.some(
    (m) => m.type.name === 'proofSuggestion' && m.attrs.kind === kind,
  )
}
