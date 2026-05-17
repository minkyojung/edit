/**
 * Domain — MarkStore implementation.
 *
 * Phase 1 implementation of the MarkStore interface defined in
 * `./markStore.ts`. Talks directly to the active doc's Y.Doc and
 * EditorView — no proof-server round-trip. The factory takes a
 * dependency-injection bundle so the runtime wiring (active view +
 * ydoc per slug) lives outside the domain layer; tests pass in
 * fixtures instead.
 *
 * Invariants enforced here:
 *   1. Every mutation (add / accept / reject) wraps Y.Map writes
 *      AND PM transaction dispatch in ONE `ydoc.transact(..., 'mark-
 *      action')` block. The UndoManager (MilkdownEditor.tsx:294-342)
 *      tracks that origin, so a single Cmd+Z reverses both halves.
 *   2. PM marks carry only the mark id as an attr; all other metadata
 *      lives in Y.Map<Mark>('marks'). The PM mark is visibility +
 *      click affordance; the Y.Map entry is identity.
 *   3. Read methods skip entries that fail `isValidMark` so legacy/
 *      corrupted data never reaches UI.
 *   4. `list` re-evaluates drift against the live doc text on every
 *      call. Stale transitions are auto-applied and surface to UI
 *      without a separate poll.
 */

import type { EditorView } from '@milkdown/kit/prose/view'
import type * as Y from 'yjs'
import {
  isStaleMark,
  isValidMark,
  type Mark,
  type MarkKind,
  type MarkStatus,
  type SuggestionType,
} from './marks'
import type {
  AddMarkArgs,
  AddMarkFailureReason,
  AddMarkResult,
  ActOnMarkArgs,
  ListMarksOptions,
  MarkStore,
  MarksListener,
} from './markStore'
import { decodeAnchor, encodeAnchor } from './internal/anchor'
import { findQuoteInDoc, readQuoteAt } from './internal/quote'
import {
  kindForSchemaName,
  schemaNameForKind,
} from './internal/schemaMap'

/** Per-slug handle the factory needs to operate on a doc.
 *
 * `view` is nullable because read methods (get / list / subscribe)
 * only need the Y.Doc — they observe the marks Y.Map directly. The
 * EditorView is required only for PM mutations (add / accept /
 * reject), so a handle with `view: null` is still useful for
 * reactive UI that subscribes before the editor mounts (typical
 * React render-then-effect order). PM-mutating methods surface
 * `view_not_ready` to the caller when the view is missing. */
export interface MarkStoreHandle {
  view: EditorView | null
  ydoc: Y.Doc
}

/** Dependency-injection bundle. Lookup is per-slug because handles
 * come and go (doc switch, archive). Returning null is normal —
 * the call site will surface `view_not_ready`. */
export interface MarkStoreDeps {
  getHandle: (slug: string) => MarkStoreHandle | null
}

/** Origin tag for the UndoManager. See MilkdownEditor.tsx:328 —
 * the editor's UndoManager tracks `'mark-action'` so PM + Y.Map
 * mutations under this origin are one undo step. */
const MARK_ORIGIN = 'mark-action'

/** Yjs Map key — the same name proof-sdk used, kept for migration
 * compatibility (existing user docs already carry a Y.Map at this
 * key). The shape inside has changed (per Phase 0's Mark model)
 * but Yjs is opaque about value shapes. */
const MARKS_MAP_KEY = 'marks'

export function createMarkStore(deps: MarkStoreDeps): MarkStore {
  const { getHandle } = deps

  function marksMapOf(ydoc: Y.Doc): Y.Map<Mark> {
    return ydoc.getMap<Mark>(MARKS_MAP_KEY)
  }

  async function add(args: AddMarkArgs): Promise<AddMarkResult> {
    const argReason = validateAddArgs(args)
    if (argReason) return { ok: false, reason: argReason }

    const handle = getHandle(args.slug)
    if (!handle || !handle.view) return { ok: false, reason: 'view_not_ready' }
    const { view, ydoc } = handle

    // Selection-driven callers (MarkToolbar) pass an explicit range
    // because the same `quote` text may appear multiple times in
    // the doc and searching would land the mark on the wrong copy.
    // AI-emitted proposals omit it; we search for the first match
    // of the quote in that case.
    const anchor = args.anchor ?? findQuoteInDoc(view, args.quote)
    if (!anchor) return { ok: false, reason: 'anchor_not_found' }

    let startRel: string
    let endRel: string
    try {
      startRel = encodeAnchor(view, anchor.from)
      endRel = encodeAnchor(view, anchor.to)
    } catch (e) {
      // ySyncPluginKey state missing — doc not bound yet. Surface
      // as view_not_ready so the caller can retry or queue.
      void e
      return { ok: false, reason: 'view_not_ready' }
    }

    const id = crypto.randomUUID()
    const createdAt = new Date().toISOString()
    const mark: Mark = {
      id,
      kind: args.kind,
      suggestionType: args.kind === 'suggestion' ? args.suggestionType : undefined,
      quote: args.quote,
      startRel,
      endRel,
      content: args.content,
      text: args.text,
      rationale: args.rationale,
      status: 'pending',
      by: args.by,
      createdAt,
      sourceSlug: args.sourceSlug,
      sourceLabel: args.sourceLabel,
      sourceQuote: args.sourceQuote,
      model: args.model,
    }

    const schemaName = schemaNameForKind(args.kind)
    const markType = view.state.schema.marks[schemaName]
    if (!markType) {
      // Schema doesn't define this mark — fatal, not a user-recoverable
      // failure. Surface as invalid_args so the call site sees an
      // explicit reason rather than a thrown exception.
      return { ok: false, reason: 'invalid_args' }
    }

    // Hover / popover surfaces (MarkPopoverLayer, MarkHoverActionsLayer)
    // read body / quote / content directly off the PM mark attrs —
    // PM is the single source of truth for what the mark says, so
    // Cmd+Z restores both the mark and its contents atomically without
    // a Y.Map round-trip. The attrs we stamp here must therefore cover
    // every field those surfaces read. Mirrors the previous MarkToolbar
    // stampInlineMark shape verbatim.
    const pmAttrs = buildPMAttrs(mark)

    ydoc.transact(() => {
      marksMapOf(ydoc).set(id, mark)
      const tr = view.state.tr
        .addMark(anchor.from, anchor.to, markType.create(pmAttrs))
        .setMeta(MARK_ORIGIN, { kind: 'add', id })
      view.dispatch(tr)
    }, MARK_ORIGIN)

    return { ok: true, markId: id }
  }

  async function reject(args: ActOnMarkArgs): Promise<boolean> {
    const handle = getHandle(args.slug)
    if (!handle) return false
    const { view, ydoc } = handle
    const map = marksMapOf(ydoc)
    const mark = map.get(args.markId)
    if (!mark) return false

    // View may be absent — e.g. the user switched away from this
    // slug between proposal and reject. Drop the Y.Map entry so the
    // metadata doesn't orphan; the PM mark on this doc gets swept by
    // markCleanupPlugin when the user next opens it.
    const range = view ? findMarkRange(view, args.markId, mark.kind) : null

    ydoc.transact(() => {
      if (view && range) {
        const schemaName = schemaNameForKind(mark.kind)
        const markType = view.state.schema.marks[schemaName]
        if (markType) {
          const tr = view.state.tr
            .removeMark(range.from, range.to, markType)
            .setMeta(MARK_ORIGIN, { kind: 'reject', id: args.markId })
          view.dispatch(tr)
        }
      }
      map.delete(args.markId)
    }, MARK_ORIGIN)

    return true
  }

  async function accept(args: ActOnMarkArgs): Promise<boolean> {
    const handle = getHandle(args.slug)
    if (!handle || !handle.view) return false
    const { view, ydoc } = handle
    const map = marksMapOf(ydoc)
    const mark = map.get(args.markId)
    if (!mark || !isValidMark(mark)) return false

    // 'authored' marks have no accept lifecycle — they're permanent
    // breadcrumbs. We return true so the interface stays uniform
    // (callers don't have to branch on kind for the happy path).
    if (mark.kind === 'authored') return true

    const range = findMarkRange(view, args.markId, mark.kind)
    if (!range) {
      // The PM mark is gone (e.g. user deleted the text it anchored
      // to). Mark stays in Y.Map with status='stale' so UI can
      // surface; no body mutation.
      ydoc.transact(() => {
        map.set(args.markId, { ...mark, status: 'stale' })
      }, MARK_ORIGIN)
      return false
    }

    // For suggestions, the body changes — drift-check first.
    if (mark.kind === 'suggestion') {
      const currentQuote = readQuoteAt(view, range.from, range.to)
      if (isStaleMark(mark, currentQuote)) {
        ydoc.transact(() => {
          map.set(args.markId, { ...mark, status: 'stale' })
        }, MARK_ORIGIN)
        return false
      }
      return applySuggestion(view, ydoc, map, mark, range, args.by)
    }

    // Comments: accept == resolve. PM mark stays in place so the UI
    // can render the resolved indicator; no body mutation.
    ydoc.transact(() => {
      map.set(args.markId, {
        ...mark,
        status: 'accepted',
        acceptedAt: new Date().toISOString(),
      })
    }, MARK_ORIGIN)
    return true
  }

  function get(slug: string, markId: string): Mark | null {
    const handle = getHandle(slug)
    if (!handle) return null
    const mark = marksMapOf(handle.ydoc).get(markId)
    if (!mark || !isValidMark(mark)) return null
    return mark
  }

  function list(slug: string, options?: ListMarksOptions): Mark[] {
    const handle = getHandle(slug)
    if (!handle) return []
    const { view, ydoc } = handle
    const map = marksMapOf(ydoc)

    const result: Mark[] = []
    map.forEach((rawMark) => {
      if (!isValidMark(rawMark)) return
      // Drift check needs the live PM doc. When view isn't mounted
      // (read-before-editor-ready), return the stored mark as-is —
      // the next call after view mount will refresh status, and the
      // PM-bound mark in the doc tells the user the same thing
      // visually.
      const refreshed = view
        ? refreshDriftStatus(view, ydoc, map, rawMark)
        : rawMark
      if (options?.status && refreshed.status !== options.status) return
      result.push(refreshed)
    })
    return result
  }

  function subscribe(slug: string, listener: MarksListener): () => void {
    const handle = getHandle(slug)
    if (!handle) return () => undefined
    const map = marksMapOf(handle.ydoc)

    const notify = () => listener(list(slug))
    map.observe(notify)
    // Initial fire so the listener sees the current state without
    // waiting for the next mutation.
    notify()
    return () => map.unobserve(notify)
  }

  return { add, accept, reject, get, list, subscribe }
}

/** Compose the attrs we stamp onto the inline PM mark.
 *
 * Schema-narrowed surface (Phase 3.G.2): PM marks carry only the
 * anchor identity (`id` + `by`) and, for suggestions, the visual
 * sub-type (`kind` — insert/delete/replace, drives the deco CSS
 * class and accept-branch selection in markStoreImpl). Rich
 * metadata (quote / content / status / createdAt / sourceLabel / …)
 * lives on the domain Mark in Y.Map('marks'), keyed by `id`. Hover
 * popover + click-popover both read from the Y.Map domain object —
 * see MarkPopoverLayer.tsx header comment ("backed Mark domain
 * object, not from PM mark.attrs"). */
function buildPMAttrs(mark: Mark): Record<string, unknown> {
  const base = { id: mark.id, by: mark.by }
  if (mark.kind === 'suggestion') {
    return { ...base, kind: mark.suggestionType ?? 'replace' }
  }
  return base
}

// ── internal helpers ──────────────────────────────────────────────

function validateAddArgs(args: AddMarkArgs): AddMarkFailureReason | null {
  if (!args.slug) return 'invalid_args'
  if (typeof args.quote !== 'string' || args.quote.length === 0) return 'invalid_args'
  if (typeof args.by !== 'string' || args.by.length === 0) return 'invalid_args'

  if (args.kind === 'suggestion') {
    if (!args.suggestionType) return 'invalid_args'
    if (args.suggestionType === 'insert' || args.suggestionType === 'replace') {
      if (typeof args.content !== 'string' || args.content.length === 0) {
        return 'invalid_args'
      }
    }
    if (args.suggestionType === 'replace' && args.content === args.quote) {
      return 'noop'
    }
  }

  if (args.kind === 'comment') {
    if (typeof args.text !== 'string' || args.text.length === 0) {
      return 'invalid_args'
    }
  }

  return null
}

/** Walk the PM doc looking for a text node carrying the proof mark
 * with this id. Returns the inclusive text-node range, or null if
 * the mark is no longer in the doc. */
function findMarkRange(
  view: EditorView,
  markId: string,
  kind: MarkKind,
): { from: number; to: number } | null {
  const wantedSchema = schemaNameForKind(kind)
  let result: { from: number; to: number } | null = null
  view.state.doc.descendants((node, pos) => {
    if (result) return false
    if (!node.isText) return undefined
    for (const m of node.marks) {
      const mappedKind = kindForSchemaName(m.type.name)
      if (!mappedKind) continue
      if (m.type.name !== wantedSchema) continue
      if (m.attrs.id !== markId) continue
      result = { from: pos, to: pos + node.nodeSize }
      return false
    }
    return undefined
  })
  return result
}

/** If a mark's quote no longer matches the live text, transition it
 * to 'stale'. If a stale mark's quote starts matching again (user
 * undid the offending edit), transition it back to 'pending'.
 *
 * Pure read-path side effect — we want list/hover to surface drift
 * without callers having to call a separate drift-check. */
function refreshDriftStatus(
  view: EditorView,
  ydoc: Y.Doc,
  map: Y.Map<Mark>,
  mark: Mark,
): Mark {
  // Only suggestion marks anchor to body text in a drift-detectable
  // way. Comments and authored marks don't represent a pending
  // mutation; their staleness isn't meaningful.
  if (mark.kind !== 'suggestion') return mark
  if (mark.status !== 'pending' && mark.status !== 'stale') return mark

  let range: { from: number; to: number } | null
  try {
    const startPos = decodeAnchor(view, mark.startRel)
    const endPos = decodeAnchor(view, mark.endRel)
    if (startPos === null || endPos === null) {
      range = findMarkRange(view, mark.id, mark.kind)
    } else {
      range = { from: startPos, to: endPos }
    }
  } catch {
    range = findMarkRange(view, mark.id, mark.kind)
  }

  if (!range) {
    if (mark.status !== 'stale') {
      const updated = { ...mark, status: 'stale' as MarkStatus }
      ydoc.transact(() => map.set(mark.id, updated), MARK_ORIGIN)
      return updated
    }
    return mark
  }

  const currentQuote = readQuoteAt(view, range.from, range.to)
  const isStale = isStaleMark(mark, currentQuote)

  if (isStale && mark.status === 'pending') {
    const updated = { ...mark, status: 'stale' as MarkStatus }
    ydoc.transact(() => map.set(mark.id, updated), MARK_ORIGIN)
    return updated
  }
  if (!isStale && mark.status === 'stale') {
    const updated = { ...mark, status: 'pending' as MarkStatus }
    ydoc.transact(() => map.set(mark.id, updated), MARK_ORIGIN)
    return updated
  }
  return mark
}

function applySuggestion(
  view: EditorView,
  ydoc: Y.Doc,
  map: Y.Map<Mark>,
  mark: Mark,
  range: { from: number; to: number },
  acceptedBy: string,
): boolean {
  const suggestionType: SuggestionType | undefined = mark.suggestionType
  if (!suggestionType) return false

  const schema = view.state.schema
  const suggestionMarkType = schema.marks[schemaNameForKind('suggestion')]
  const authoredMarkType = schema.marks[schemaNameForKind('authored')]
  if (!suggestionMarkType) return false

  const acceptedAt = new Date().toISOString()

  // Per-branch responsibility for removing the suggestion's inline
  // mark:
  //   - delete:  tr.delete drops the entire range; the mark dies with
  //              its anchor text. No follow-up removeMark needed.
  //   - insert:  tr.insertText leaves the original [from, to] text
  //              (still carrying the suggestion mark) untouched. We
  //              MUST strip the mark off it after stamping the
  //              authored breadcrumb on the inserted content.
  //   - replace: tr.replaceWith swaps the marked content for fresh
  //              text; like delete, the mark dies with the original.
  //              No follow-up removeMark needed.
  //
  // The previous unified `tr.removeMark(range.from, range.to, ...)`
  // at the bottom looked symmetric but did different things per
  // branch — and crucially, was buggy for replace at end-of-doc:
  // after replaceWith shrinks the doc, range.to may now point past
  // doc.content.size, which trips PM's bounds check when walking
  // children for the mark removal.
  ydoc.transact(() => {
    let tr = view.state.tr

    if (suggestionType === 'delete') {
      tr = tr.delete(range.from, range.to)
    } else if (suggestionType === 'insert') {
      const text = mark.content ?? ''
      tr = tr.insertText(text, range.to, range.to)
      if (authoredMarkType) {
        const authoredId = crypto.randomUUID()
        tr = tr.addMark(range.to, range.to + text.length, authoredMarkType.create({ id: authoredId }))
        // Companion Y.Map entry for the authored breadcrumb. Keeps
        // the same provenance the suggestion carried so hover UI
        // can answer "where did this come from?" after accept.
        map.set(authoredId, {
          id: authoredId,
          kind: 'authored',
          quote: text,
          startRel: mark.startRel,
          endRel: mark.endRel,
          status: 'accepted',
          by: mark.by,
          createdAt: acceptedAt,
          acceptedAt,
          sourceSlug: mark.sourceSlug,
          sourceLabel: mark.sourceLabel,
          sourceQuote: mark.sourceQuote ?? mark.quote,
          model: mark.model,
        })
      }
      tr = tr.removeMark(range.from, range.to, suggestionMarkType)
    } else {
      // replace
      const text = mark.content ?? ''
      tr = tr.replaceWith(range.from, range.to, schema.text(text))
      if (authoredMarkType) {
        const authoredId = crypto.randomUUID()
        tr = tr.addMark(range.from, range.from + text.length, authoredMarkType.create({ id: authoredId }))
        map.set(authoredId, {
          id: authoredId,
          kind: 'authored',
          quote: text,
          startRel: mark.startRel,
          endRel: mark.endRel,
          status: 'accepted',
          by: mark.by,
          createdAt: acceptedAt,
          acceptedAt,
          sourceSlug: mark.sourceSlug,
          sourceLabel: mark.sourceLabel,
          sourceQuote: mark.sourceQuote ?? mark.quote,
          model: mark.model,
        })
      }
    }

    tr = tr.setMeta(MARK_ORIGIN, { kind: 'accept', id: mark.id })
    view.dispatch(tr)
    map.delete(mark.id)
    void acceptedBy
  }, MARK_ORIGIN)

  return true
}
