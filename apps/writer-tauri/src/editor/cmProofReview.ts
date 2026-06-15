// CM-side AI suggestion rendering — the CodeMirror equivalent of the PM
// inlineReviewPlugin. The pendingChangesStore is the single source of truth; this
// only READS it and derives decorations (store = truth, marks = derived):
//   • subscribe to the store → re-anchor this doc's pending edits → setAnchored
//   • each anchored edit renders: strike the old text + a green widget with the new
//     text + ✓/✕ that call store.accept/reject
//   • positions track edits via the field's map() while the doc is open
//
// Scope: inline `replace` (before→after), `delete` (before→∅), and `add` (insertion at
// an anchor / append) — chat propose_edit + ingest proposals. Whole-file Write /
// multi-line hunks are still Stage 3-2. Accept persists via the existing applier; the
// live-doc refresh on accept is wired separately (the applyToWikiPage CM bridge).

import { StateField, StateEffect, type EditorState, type Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from '@codemirror/view'
import { invertedEffects } from '@codemirror/commands'
import { usePendingChangesStore, rejectPendingChange, type PendingChange } from '@/state/pendingChangesStore'
import { looseFindRange } from '@/lib/looseMatch'
import { renderInline } from '@/prototypes/widgets'

// Undo-link for accept: the accept's doc change (dispatched by the CM bridge) carries
// `acceptEffect.of(changeId)`. invertedEffects makes its undo carry `reopenEffect`, so
// Cmd-Z reverts the doc AND reopens the change (the mark comes back). The watcher below
// calls store.accept/reopen accordingly. Exported so CmEditor's bridge can tag the
// accept transaction.
export const acceptEffect = StateEffect.define<string>() // changeId
// Reject is dispatched as an EFFECT-ONLY transaction (no doc change) so it lands in
// CM's history and Cmd-Z can undo it — a plain store.reject leaves no undoable trace.
// Exported so the registered reject-bridge (CmEditor) dispatches it; both the inline ✕
// and the chat panel reach this same path via rejectPendingChange.
export const rejectEffect = StateEffect.define<string>() // changeId
const reopenEffect = StateEffect.define<string>() // changeId

const acceptUndoLink = invertedEffects.of((tr) => {
  const out: StateEffect<unknown>[] = []
  for (const e of tr.effects) {
    // The inverse of an accept/reject is "reopen" (un-decide). Redo replays the
    // original transaction's own effect, so no reopen→accept/reject mapping is needed.
    if (e.is(acceptEffect) || e.is(rejectEffect)) out.push(reopenEffect.of(e.value))
  }
  return out
})

const acceptUndoWatcher = EditorView.updateListener.of((u) => {
  for (const tr of u.transactions) {
    for (const e of tr.effects) {
      // Defer the store mutation: it triggers cmProofReview's subscription →
      // view.dispatch, which is illegal during an update. accept/reject are idempotent.
      const store = usePendingChangesStore.getState()
      if (e.is(acceptEffect)) {
        const id = e.value
        queueMicrotask(() => store.accept(id))
      } else if (e.is(rejectEffect)) {
        const id = e.value
        queueMicrotask(() => store.reject(id))
      } else if (e.is(reopenEffect)) {
        const id = e.value
        queueMicrotask(() => store.reopen(id))
      }
    }
  }
})

type AnchoredEdit = {
  changeId: string
  editId: string
  from: number
  to: number // end of the matched `before`; for 'add' === from (a pure insertion point)
  after: string // replacement / inserted text ('' for a delete)
  kind: 'replace' | 'delete' | 'add'
}

const setAnchored = StateEffect.define<AnchoredEdit[]>()

/** Where an `add` lands: end of doc for the empty anchor (append), else just after the
 * LAST occurrence of the anchor text. Mirrors the applier's insertion rule so "a widget
 * shows" ⟺ "Keep inserts there". */
function resolveAddInsertion(doc: string, anchor: string): number | null {
  if (anchor.length === 0) return doc.length
  const i = doc.lastIndexOf(anchor)
  return i < 0 ? null : i + anchor.length
}

const anchoredField = StateField.define<AnchoredEdit[]>({
  create: () => [],
  update(value, tr) {
    let next = value
    if (tr.docChanged) {
      next = value
        .map((a) => {
          const from = tr.changes.mapPos(a.from, 1)
          // 'add' is a pure insertion point (to === from); replace/delete keep their range.
          const to = a.kind === 'add' ? from : tr.changes.mapPos(a.to, -1)
          return { ...a, from, to }
        })
        // Drop a replace/delete whose `before` range collapsed; 'add' (to === from) stays.
        .filter((a) => a.kind === 'add' || a.to > a.from)
    }
    for (const e of tr.effects) if (e.is(setAnchored)) next = e.value
    return next
  },
})

/** Anchor each pending edit's `before` text in the doc using the SAME matcher the
 * applier uses (looseFindRange) — so "a mark shows" ⟺ "Keep will place it". Unfound
 * edits are dropped for now; the unplaced tray is Stage 3-1c. */
function anchorChanges(docText: string, changes: PendingChange[]): AnchoredEdit[] {
  const out: AnchoredEdit[] = []
  for (const c of changes) {
    for (const e of c.edits) {
      if ((e.kind === 'replace' || e.kind === 'delete') && e.before) {
        const range = looseFindRange(docText, e.before)
        if (!range) continue
        out.push({
          changeId: c.id,
          editId: e.id,
          from: range.start,
          to: range.end,
          after: e.kind === 'delete' ? '' : (e.after ?? ''),
          kind: e.kind,
        })
      } else if (e.kind === 'add') {
        // Insertion: anchor at the LAST occurrence of `anchorBefore` (empty → append at
        // end of doc). No `before` range to strike — a pure insertion point (from === to).
        const at = resolveAddInsertion(docText, e.anchorBefore)
        if (at === null) continue
        out.push({
          changeId: c.id,
          editId: e.id,
          from: at,
          to: at,
          after: e.after ?? '',
          kind: 'add',
        })
      }
      // Whole-file 'replace' (no `before`) → hunk-shaped, still Stage 3-2.
    }
  }
  return out
}

/** Best doc offset to scroll to for a change — used when the user clicks a chat
 * suggestion card to jump to the spot in the note. Prefers the resulting `after` text
 * (present once accepted, a fine target while pending too), then the `before` anchor,
 * then an `add`'s insertion point. Null when nothing resolves (e.g. a rejected change
 * whose text never landed). */
export function scrollOffsetForChange(docText: string, change: PendingChange): number | null {
  for (const e of change.edits) {
    if (e.after) {
      const r = looseFindRange(docText, e.after)
      if (r) return r.start
    }
    if (e.before) {
      const r = looseFindRange(docText, e.before)
      if (r) return r.start
    }
    if (e.kind === 'add') {
      const at = resolveAddInsertion(docText, e.anchorBefore)
      if (at !== null) return at
    }
  }
  return null
}

const accept = (id: string) => usePendingChangesStore.getState().accept(id)

const proofBtn = (label: string, cls: string, fn: () => void): HTMLButtonElement => {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = cls
  b.textContent = label
  b.addEventListener('mousedown', (e) => {
    e.preventDefault()
    e.stopPropagation()
    fn()
  })
  return b
}

// Inline review: short single-line replace/delete → green replacement + ✓/✕ in flow.
class ReviewWidget extends WidgetType {
  constructor(readonly a: AnchoredEdit) {
    super()
  }
  eq(o: ReviewWidget) {
    return o.a.changeId === this.a.changeId && o.a.editId === this.a.editId && o.a.after === this.a.after
  }
  toDOM() {
    const box = document.createElement('span')
    box.className = 'cm-proof-review'
    if ((this.a.kind === 'replace' || this.a.kind === 'add') && this.a.after) {
      const ins = document.createElement('span')
      ins.className = 'cm-proof-new'
      // Render INLINE markdown (bold/italic/code/strike/link) inside the green
      // highlight; block markers (##, -) in a large insertion stay literal — inline
      // by design. `white-space: pre-wrap` (theme) keeps line breaks + wraps.
      ins.append(...renderInline(this.a.after))
      box.append(ins)
    }
    box.append(
      proofBtn('✓', 'cm-proof-keep', () => accept(this.a.changeId)),
      // Same shared path the chat panel uses → undoable when this doc is open.
      proofBtn('✕', 'cm-proof-reject', () => rejectPendingChange(this.a.changeId)),
    )
    return box
  }
  ignoreEvent() {
    return true
  }
}

function build(state: EditorState): DecorationSet {
  const ranges = state.field(anchoredField).flatMap((a) =>
    a.kind === 'add'
      ? // Pure insertion: no old text to strike — just the green widget at the point.
        [Decoration.widget({ widget: new ReviewWidget(a), side: 1 }).range(a.from)]
      : [
          Decoration.mark({ class: 'cm-proof-old' }).range(a.from, a.to),
          Decoration.widget({ widget: new ReviewWidget(a), side: 1 }).range(a.to),
        ],
  )
  return Decoration.set(ranges, true)
}

const proofTheme = EditorView.theme({
  '.cm-proof-old': {
    textDecoration: 'line-through',
    color: 'var(--muted-foreground)',
    background: 'color-mix(in oklch, var(--destructive, crimson) 14%, transparent)',
    borderRadius: '2px',
  },
  '.cm-proof-new': {
    color: 'var(--foreground)',
    background: 'color-mix(in oklch, #2ecc71 22%, transparent)',
    borderRadius: '2px',
    padding: '0 0.15em',
    marginLeft: '0.15em',
    // Wrap within the editor column (no nowrap) and keep the insertion's own line
    // breaks instead of collapsing them to spaces.
    whiteSpace: 'pre-wrap',
  },
  '.cm-proof-keep, .cm-proof-reject': {
    fontSize: '11px',
    lineHeight: '1',
    padding: '1px 4px',
    marginLeft: '3px',
    border: '1px solid var(--border)',
    borderRadius: '4px',
    cursor: 'pointer',
    background: 'var(--background)',
  },
  '.cm-proof-keep': { color: '#2ecc71' },
  '.cm-proof-reject': { color: 'var(--destructive, crimson)' },
})

const serialise = (pending: PendingChange[]) => pending.map((c) => `${c.id}:${c.edits.length}`).join('|')

/** AI suggestion review layer for the doc `slug`. Subscribes to the store and keeps
 * the decorations in sync. */
export function cmProofReview(slug: string): Extension {
  const reanchor = (view: EditorView) => {
    const pending = usePendingChangesStore.getState().pendingForPage(slug)
    view.dispatch({ effects: setAnchored.of(anchorChanges(view.state.doc.toString(), pending)) })
  }
  const sub = ViewPlugin.fromClass(
    class {
      unsub: () => void
      last: string
      constructor(readonly view: EditorView) {
        this.last = serialise(usePendingChangesStore.getState().pendingForPage(slug))
        // Defer the first anchor — dispatching during view construction is illegal.
        requestAnimationFrame(() => reanchor(view))
        this.unsub = usePendingChangesStore.subscribe(() => {
          const cur = serialise(usePendingChangesStore.getState().pendingForPage(slug))
          if (cur === this.last) return
          this.last = cur
          reanchor(view)
        })
      }
      destroy() {
        this.unsub()
      }
    },
  )
  return [
    anchoredField,
    EditorView.decorations.compute([anchoredField], build),
    proofTheme,
    sub,
    acceptUndoLink,
    acceptUndoWatcher,
  ]
}
