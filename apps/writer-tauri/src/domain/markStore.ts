/**
 * Domain — MarkStore (interface only).
 *
 * The single mutation surface for marks. Every place in the app that
 * creates, accepts, or rejects a mark routes through these five
 * methods — that's the whole point of this module: one path, one
 * place where Y.Doc mutations and ProseMirror transactions coexist
 * under a single transactional origin.
 *
 * Why this exists:
 *   Mark mutations were previously fractured across at least three
 *   call sites (markActions, applyProposal, MarkToolbar) each
 *   composing Y.Map writes + PM transactions in slightly different
 *   sequences. The drift detector + projection-repair quarantine
 *   class of bugs we hit downstream (`node.children.some` crashes,
 *   pathological_repeat quarantine, the split-tr workaround) all
 *   surfaced because no two call sites agreed on what "create a
 *   mark" meant. Centralizing here means the invariant — Y.Map +
 *   PM mutation under one `mark-action` origin so the Y.UndoManager
 *   captures both halves atomically — is enforced in exactly one
 *   place.
 *
 * Phase 0 produces this file as an interface stub. No implementation.
 * Phase 1 wires up the in-memory implementation that talks directly
 * to the active doc's Y.Doc + EditorView.
 */

import type { Mark, MarkKind, MarkStatus, SuggestionType } from './marks'

/** Arguments to `MarkStore.add`. The mark id, status, createdAt, and
 * RelativePosition anchor are all decided by the implementation; the
 * caller supplies the user-visible payload. */
export interface AddMarkArgs {
  /** Doc this mark belongs to. */
  slug: string

  /** What kind of mark. See domain/marks.ts. */
  kind: MarkKind

  /** Required when kind === 'suggestion'. */
  suggestionType?: SuggestionType

  /** Text the mark anchors to. Required because every mark anchors
   * to something — there is no "floating" mark. The implementation
   * uses this to recover the anchor if `anchor` (below) isn't passed,
   * AND stores it on the mark for drift detection regardless. */
  quote: string

  /** Explicit PM range to anchor at. Optional. When omitted, the
   * implementation searches the live doc for the first occurrence
   * of `quote`. Pass this from selection-driven flows (MarkToolbar)
   * where the caller already knows the exact range — without it,
   * a quote like "the" would land on the first "the" in the doc,
   * not the one the user selected. AI-emitted proposals leave it
   * blank because the model only knows the quote text, not a PM
   * position. */
  anchor?: { from: number; to: number }

  /** New text for the suggestion. Required for suggestion of type
   * 'insert' or 'replace'. */
  content?: string

  /** Body of the comment. Required when kind === 'comment'. */
  text?: string

  /** Short author-supplied reason ("missing article", "spelling").
   * Surfaced in the hover bar and popover. Optional. */
  rationale?: string

  /** Attribution. See Mark.by. */
  by: string

  /** Provenance for AI-originated marks (where the source content
   * came from). All optional — human-created marks leave them blank. */
  sourceSlug?: string
  sourceLabel?: string
  sourceQuote?: string
  model?: string
}

/** Outcome of `MarkStore.add`. The result is structured (not a thrown
 * exception) because anchor lookup failure is a recoverable case the
 * caller often surfaces to UI rather than logging as an error. */
export type AddMarkResult =
  | { ok: true; markId: string }
  | { ok: false; reason: AddMarkFailureReason }

/** Failure cases the caller must handle when adding a mark.
 *
 *   view_not_ready   — the doc's EditorView hasn't mounted yet.
 *                       Caller can retry after waiting or queue.
 *   anchor_not_found — `quote` doesn't appear in the live doc text.
 *                       Usually means the doc was edited between the
 *                       call site producing the proposal and this
 *                       call landing. Caller should surface to user.
 *   invalid_args     — quote/content/text was empty when required.
 *                       Caller bug; should never reach here in
 *                       practice but the result type forces a check.
 *   noop             — suggestion of type 'replace' where
 *                       content === quote. Caller can suppress
 *                       silently. */
export type AddMarkFailureReason =
  | 'view_not_ready'
  | 'anchor_not_found'
  | 'invalid_args'
  | 'noop'

/** Arguments shared by accept / reject. */
export interface ActOnMarkArgs {
  slug: string
  markId: string
  by: string
}

/** Filter options for `MarkStore.list`. */
export interface ListMarksOptions {
  /** When provided, return only marks whose status matches. Omit
   * to return all marks (most callers want pending + stale; some
   * want everything for debugging). */
  status?: MarkStatus
}

/** Listener for `MarkStore.subscribe`. Called on every mark change
 * for the slug with the full current list. */
export type MarksListener = (marks: Mark[]) => void

/**
 * The mark mutation interface.
 *
 * Lifecycle relationship to other systems:
 *
 *   ┌──────────────┐  add()    ┌───────────┐  Y.Map(marks) + PM tr
 *   │ applyProposal│ ────────► │ MarkStore │ ──────────────────────►
 *   │ MarkToolbar  │  accept() │           │   (one 'mark-action'
 *   │ banner       │  reject() │           │    origin → UndoManager
 *   └──────────────┘           └───────────┘    sees both halves)
 *
 * The store does not own a backing data structure; mutations land in
 * the doc's existing Y.Doc + Y.Map('marks'), and Yjs handles the
 * propagation (IDB persistence + HocuspocusProvider sync if present).
 * The store is a façade — its job is to ensure both mutations always
 * happen together under the right origin.
 *
 * Read methods (`get`, `list`, `subscribe`) are thin wrappers around
 * the same Y.Map, with the value-shape validation from `isValidMark`
 * applied so legacy / corrupted entries don't propagate.
 */
export interface MarkStore {
  /**
   * Create a new mark.
   *
   * Implementation steps (Phase 1):
   *   1. Look up the EditorView + Y.Doc for `args.slug`. If absent,
   *      return `view_not_ready`.
   *   2. Search the live doc text for `args.quote`. If not found,
   *      return `anchor_not_found`.
   *   3. Encode the anchor as Y.RelativePosition (base64) for
   *      both start and end.
   *   4. Generate `id` via `crypto.randomUUID()`.
   *   5. In ONE `ydoc.transact(..., 'mark-action')` block:
   *      - Write the Mark into `Y.Map<Mark>('marks')`.
   *      - Dispatch a PM transaction with `tr.addMark(...)` and
   *        the meta `setMeta('mark-action', { kind: 'add', id })`.
   *
   * The two mutations must share one origin so the Y.UndoManager
   * (see MilkdownEditor.tsx:294-342) sees them as a single undo
   * step. Without this, Cmd+Z leaves Y.Map and PM in inconsistent
   * states.
   */
  add(args: AddMarkArgs): Promise<AddMarkResult>

  /**
   * Accept a mark.
   *
   * For suggestions:
   *   1. Find the anchor in the live PM doc.
   *   2. Read the current text at the anchor.
   *   3. `isStaleMark(mark, currentQuote)` — if true, set
   *      status='stale', return false (no body mutation).
   *   4. Otherwise: apply the suggestion content (insert / delete
   *      / replace per `suggestionType`), remove the suggestion
   *      mark, stamp a `proofAuthored` mark over the inserted
   *      range, update status='accepted' + acceptedAt=now.
   *      All under one 'mark-action' origin.
   *
   * For comments:
   *   - Set status='accepted' (treated as "resolved"). PM mark is
   *     left in place so the UI can render the resolved indicator;
   *     no body mutation.
   *
   * For authored:
   *   - No-op. Authored marks are breadcrumbs; they don't have a
   *     user accept lifecycle. Returning true keeps the interface
   *     uniform without forcing callers to branch.
   *
   * Returns true on success, false on stale or missing mark.
   */
  accept(args: ActOnMarkArgs): Promise<boolean>

  /**
   * Reject (or dismiss) a mark.
   *
   *   - PM: `tr.removeMark(...)` for the inline mark.
   *   - Y.Map: `marksMap.delete(markId)`.
   *   - Both under one 'mark-action' origin.
   *
   * No drift detection (rejection doesn't touch the body, so a
   * stale anchor doesn't matter).
   *
   * Returns true if the mark existed and was removed; false if the
   * mark id wasn't in the store (silent — caller already cleaned
   * up, or never existed).
   */
  reject(args: ActOnMarkArgs): Promise<boolean>

  /**
   * Read a mark by id. Returns null when the id isn't in the store
   * OR when the stored value fails `isValidMark` (treated as
   * absent so the caller doesn't see corrupted data).
   */
  get(slug: string, markId: string): Mark | null

  /**
   * List all marks for a doc, optionally filtered by status.
   * Returns a fresh array on each call (caller doesn't have to
   * worry about mutation). Order follows Y.Map iteration order
   * (insertion-stable across sessions for our usage).
   *
   * Implementations should re-evaluate `isStaleMark` against the
   * live doc text for each pending mark and auto-update status
   * (pending ↔ stale) at read time. This is what surfaces drift
   * to UI without requiring a separate poll loop.
   */
  list(slug: string, options?: ListMarksOptions): Mark[]

  /**
   * Subscribe to mark changes for a doc. The listener is called
   * synchronously after every mark mutation (add / accept / reject
   * / stale auto-transition). Returns an unsubscribe function.
   *
   * Typical use: React effect in a sidebar/banner component to
   * keep the mark count UI live.
   *
   * Caller is responsible for un-subscribing on unmount.
   */
  subscribe(slug: string, listener: MarksListener): () => void
}
