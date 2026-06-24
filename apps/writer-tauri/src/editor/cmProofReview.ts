// CM-side AI suggestion rendering — the CodeMirror equivalent of the PM
// inlineReviewPlugin. The pendingChangesStore is the single source of truth; this
// only READS it and derives decorations (store = truth, marks = derived):
//   • subscribe to the store → re-anchor this doc's pending edits → setAnchored
//   • each anchored edit renders: strike the old text + a green widget with the new
//     text + ✓/✕ that call store.accept/reject
//   • positions track edits via the field's map() while the doc is open
//
// Scope: ALL edit shapes — inline `replace` (before→after), `delete` (before→∅),
// `add` (insertion / append), AND whole-file Write (no `before`). Every shape is
// rendered the same way: apply the change's edits to a copy of the doc, diff the
// result against the live doc (computeCmHunks), and strike removed lines / show
// added lines as green widgets. Accept persists via the existing applier; the
// live-doc refresh on accept is wired separately (the applyToWikiPage CM bridge).

import { StateField, StateEffect, EditorState, type Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from '@codemirror/view'
import { invertedEffects } from '@codemirror/commands'
import { usePendingChangesStore, rejectPendingChange, type PendingChange } from '@/state/pendingChangesStore'
import { looseFindRange } from '@/lib/looseMatch'
import { renderInline } from '@/prototypes/widgets'
import { computeCmHunks, resolveAddInsertion } from '@/editor/cmHunks'

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

// Stage 1 — FREEZE the old (to-be-replaced) text while a suggestion is pending.
// A genuine user edit (typing / deleting) that touches a pending replace/delete
// span is dropped, so the user can't alter text that's about to be replaced — the
// source of accept-time drift / lost edits. Cursor's model: the red side is
// read-only; you edit the green proposal instead (Stage 2). Programmatic
// transactions — the accept apply, external reload, re-anchor (none carry an
// input/delete userEvent) — and undo/redo pass untouched. An 'add' is a pure
// insertion point with no old text, so nothing is protected there.
const freezeOldText = EditorState.changeFilter.of((tr) => {
  if (!(tr.isUserEvent('input') || tr.isUserEvent('delete'))) return true
  const anchored = tr.startState.field(anchoredField, false)
  if (!anchored?.length) return true
  const pairs: Array<[number, number]> = []
  for (const a of anchored) if (a.kind !== 'add' && a.to > a.from) pairs.push([a.from, a.to])
  if (!pairs.length) return true
  pairs.sort((x, y) => x[0] - y[0])
  // A flat [from, to, from, to, …] list of protected ranges: CM drops the parts of
  // this transaction's changes that touch them and keeps the rest.
  return pairs.flat()
})

/** Build the anchored hunks for every pending change on the page. Each change
 * is diffed independently against the current doc text (computeCmHunks); the
 * resulting hunks are tagged with their owning change so accept/reject route to
 * the right id. `editId` is positional within the change — stable across
 * recomputes for a given diff, and only used for widget `eq()` keying. */
function anchorChanges(docText: string, changes: PendingChange[]): AnchoredEdit[] {
  return changes.flatMap((c) =>
    computeCmHunks(docText, c).map((h, i) => ({
      changeId: c.id,
      editId: `${c.id}:${i}`,
      from: h.from,
      to: h.to,
      after: h.after,
      kind: h.kind,
    })),
  )
}

/** Best doc offset to scroll to for a change — used when the user clicks a chat
 * suggestion card to jump to the spot in the note. Prefers the resulting `after` text
 * (present once accepted, a fine target while pending too), then the `before` anchor,
 * then an `add`'s insertion point. Null when nothing resolves (e.g. a rejected change
 * whose text never landed). */
export function scrollOffsetForChange(docText: string, change: PendingChange): number | null {
  for (const e of change.edits) {
    // Prefer the `before` anchor: while the change is PENDING that's the text actually
    // in the doc now (the `after` isn't applied yet and could coincidentally match
    // unrelated text elsewhere, jumping to the wrong spot). Once accepted, `before` is
    // gone and we fall through to `after`.
    if (e.before) {
      const r = looseFindRange(docText, e.before)
      if (r) return r.start
    }
    if (e.after) {
      const r = looseFindRange(docText, e.after)
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
    freezeOldText,
    EditorView.decorations.compute([anchoredField], build),
    proofTheme,
    sub,
    acceptUndoLink,
    acceptUndoWatcher,
  ]
}

// Test-only: seed/inspect the frozen old-text spans headlessly (the ViewPlugin's
// store subscription needs a real browser).
export { anchoredField as _anchoredField, setAnchored as _setAnchored, freezeOldText as _freezeOldText }
