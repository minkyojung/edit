/**
 * Domain — Mark.
 *
 * Single source of truth for what a "mark" is in this app. A mark is
 * the on-document representation of an AI suggestion, a user comment,
 * or an authored-by-AI breadcrumb. It anchors to a text range and
 * carries the metadata the UI + lifecycle need.
 *
 * Why this file exists:
 *   The mark model was previously fractured across five locations
 *   (hooks/useCollabDoc, editor/markTypes, editor/markHoverPlugin,
 *   stores/editorFooter, export/types) each carrying its own slightly
 *   different list of "kinds". Adding a new mark type meant updating
 *   five files in lockstep, and the lists had quietly drifted (some
 *   listed dead kinds `flagged`/`approved`/`provenance`, others only
 *   the live three). This module is the consolidation target.
 *
 * Kinds narrowed from 8 → 3 (`suggestion`, `comment`, `authored`):
 *   - `flagged`, `approved`, `provenance` were never created by any
 *     code path (grep shows 0 producers); they only existed as
 *     schema definitions left over from earlier iterations.
 *   - `suggestion` absorbs the former `insert` / `delete` / `replace`
 *     kinds via the `suggestionType` discriminator.
 *
 * Not yet wired:
 *   Phase 0 produces this file but nothing imports it. Phase 1's
 *   markStore is the first consumer. Subsequent phases migrate the
 *   five legacy definition sites onto this one.
 */

/** A user/AI-attributed mark on a text range. */
export interface Mark {
  /** Stable identifier — round-trips through Y.Map and ProseMirror
   * mark attrs. Generated via crypto.randomUUID() at create time. */
  id: string

  /** What this mark represents. See top-level doc for kind narrowing. */
  kind: MarkKind

  /** Required only when kind === 'suggestion'. Distinguishes how the
   * `content` is applied at accept time. */
  suggestionType?: SuggestionType

  /** Exact text under the anchor at create time. Used to detect drift:
   * if the live text at the anchored range no longer matches this
   * snapshot, the mark is `stale` (see isStaleMark + the drift
   * policy doc). Required because every mark anchors to something. */
  quote: string

  /** Base64-encoded Y.RelativePosition for the anchor start. Survives
   * concurrent edits in a way absolute offsets don't — see
   * Y.createRelativePositionFromTypeIndex + Y.encodeRelativePosition.
   * Both startRel/endRel are required; an unanchored mark is invalid. */
  startRel: string
  /** Base64-encoded Y.RelativePosition for the anchor end. */
  endRel: string

  /** New text to apply at accept time. Required for suggestion
   * with suggestionType 'insert' or 'replace'. Ignored for 'delete'
   * and for comments. */
  content?: string

  /** Body of a comment. Required when kind === 'comment'. Ignored
   * for other kinds. */
  text?: string

  /** Short author-supplied reason for the proposal. Surfaced to the
   * user in the hover bar (suggestions) and the popover header
   * (comments) so reviewers can understand intent without re-reading
   * the original quote. Optional — human-created marks usually leave
   * it blank; AI proposals routinely carry a one-line rationale
   * (e.g. "missing article", "spelling"). */
  rationale?: string

  /** Lifecycle state. `stale` is set when an accept attempt finds
   * the live text no longer matches `quote` — see drift policy. */
  status: MarkStatus

  /** Attribution string. Format: `human:<id>` or `ai:<model-id>`.
   * Free-form so future actor categories don't require an enum
   * widening. */
  by: string

  /** ISO timestamp of creation. */
  createdAt: string

  /** ISO timestamp when the mark transitioned to `accepted`. Absent
   * for marks that never reached accepted (pending/rejected/stale). */
  acceptedAt?: string

  // ── Provenance (formerly `authoredMeta` Y.Map) ──────────────────
  // These fields are why proof-sdk's `authoredMeta` sibling map
  // existed: they describe where an AI-originated mark came from
  // outside the doc itself. Folded in here so the mark carries its
  // full identity in one place.

  /** Slug of the source document this mark's content was derived
   * from (e.g. the daily note an ingest pass read). */
  sourceSlug?: string

  /** Human-readable label for sourceSlug (e.g. "2026-05-15"). */
  sourceLabel?: string

  /** Verbatim sentence from the source document the proposal was
   * derived from. The user's audit trail for "where did this come
   * from?" when reviewing AI-generated content. */
  sourceQuote?: string

  /** Model id that produced this mark (e.g. "claude-haiku-4-5-20251001").
   * Set when kind === 'suggestion' or 'authored' AND by starts with
   * 'ai:'. */
  model?: string
}

/** The three kinds the app actually uses. Narrowed from the prior 8.
 * See the file's top-level doc for the dead kinds that were removed. */
export type MarkKind = 'suggestion' | 'comment' | 'authored'

/** Discriminator on `kind: 'suggestion'`. How the suggestion's content
 * is applied at accept time. Previously these were top-level mark
 * kinds; folded in here because the lifecycle is identical across all
 * three (anchor, accept/reject, drift-detect). */
export type SuggestionType = 'insert' | 'delete' | 'replace'

/** Lifecycle state of a mark.
 *
 *   pending   — created, awaiting user decision (or never accepted in
 *               the case of comments)
 *   accepted  — applied to the doc; for comments, treated as "resolved"
 *   rejected  — user dismissed; the mark is typically deleted from
 *               the store at this point, but the status is here for
 *               in-flight transitions
 *   stale     — set when the anchored text no longer matches `quote`
 *               at the time an action was attempted. The mark stays
 *               in the store with this status so the UI can render
 *               "no longer applies" and the user can dismiss.
 */
export type MarkStatus = 'pending' | 'accepted' | 'rejected' | 'stale'

const KINDS: ReadonlySet<MarkKind> = new Set(['suggestion', 'comment', 'authored'])
const SUGGESTION_TYPES: ReadonlySet<SuggestionType> = new Set([
  'insert',
  'delete',
  'replace',
])
const STATUSES: ReadonlySet<MarkStatus> = new Set([
  'pending',
  'accepted',
  'rejected',
  'stale',
])

/**
 * Type guard. Returns true when `value` is structurally a Mark.
 *
 * Validates the invariants the rest of the app assumes about a Mark
 * regardless of how it arrived (Y.Map deserialization, server response,
 * legacy migration). Failing here is preferred to letting an
 * ill-formed mark propagate into the editor where its absence of
 * (e.g.) `quote` would surface as a hover popover crash.
 */
export function isValidMark(value: unknown): value is Mark {
  if (!isRecord(value)) return false

  if (typeof value.id !== 'string' || value.id.length === 0) return false
  if (typeof value.kind !== 'string' || !KINDS.has(value.kind as MarkKind)) return false
  if (typeof value.quote !== 'string') return false
  if (typeof value.startRel !== 'string' || value.startRel.length === 0) return false
  if (typeof value.endRel !== 'string' || value.endRel.length === 0) return false
  if (typeof value.status !== 'string' || !STATUSES.has(value.status as MarkStatus)) {
    return false
  }
  if (typeof value.by !== 'string' || value.by.length === 0) return false
  if (typeof value.createdAt !== 'string' || value.createdAt.length === 0) return false

  // Kind-specific shape:
  if (value.kind === 'suggestion') {
    if (
      typeof value.suggestionType !== 'string' ||
      !SUGGESTION_TYPES.has(value.suggestionType as SuggestionType)
    ) {
      return false
    }
    // insert / replace require content; delete does not.
    if (value.suggestionType === 'insert' || value.suggestionType === 'replace') {
      if (typeof value.content !== 'string' || value.content.length === 0) return false
    }
  }

  if (value.kind === 'comment') {
    if (typeof value.text !== 'string' || value.text.length === 0) return false
  }

  // Optional fields, when present, must be strings:
  if (value.acceptedAt !== undefined && typeof value.acceptedAt !== 'string') return false
  if (value.rationale !== undefined && typeof value.rationale !== 'string') return false
  if (value.sourceSlug !== undefined && typeof value.sourceSlug !== 'string') return false
  if (value.sourceLabel !== undefined && typeof value.sourceLabel !== 'string') return false
  if (value.sourceQuote !== undefined && typeof value.sourceQuote !== 'string') return false
  if (value.model !== undefined && typeof value.model !== 'string') return false

  return true
}

/**
 * Drift detection. Returns true when `mark.quote` and `currentQuote`
 * disagree — i.e. the live text under the mark's anchor is no longer
 * what it was when the mark was created.
 *
 * The single entry point for drift judgment in this codebase. See
 * `docs/refactor-proof-sdk-removal/policies/marks-drift.md` for the
 * policy rationale (we detect drift but do not attempt to relocate
 * the mark — stale marks surface to the user instead of silently
 * moving).
 *
 * Empty `mark.quote` is a validation issue, not a drift judgment;
 * this function returns false in that case so callers don't mark
 * an already-malformed mark as drifted.
 */
export function isStaleMark(mark: Mark, currentQuote: string): boolean {
  if (mark.quote.length === 0) return false
  return mark.quote !== currentQuote
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
