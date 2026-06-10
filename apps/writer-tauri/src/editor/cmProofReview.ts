// CM-side AI suggestion rendering — the CodeMirror equivalent of the PM
// inlineReviewPlugin. The pendingChangesStore is the single source of truth; this
// only READS it and derives decorations (store = truth, marks = derived):
//   • subscribe to the store → re-anchor this doc's pending edits → setAnchored
//   • each anchored edit renders: strike the old text + a green widget with the new
//     text + ✓/✕ that call store.accept/reject
//   • positions track edits via the field's map() while the doc is open
//
// Stage 3-1a scope: inline `replace` (before→after) and `delete` (before→∅) — the
// common chat propose_edit shape. Whole-file Write / multi-line hunks / block inserts
// are Stage 3-2. Accept persists via the existing applier; the live-doc refresh on
// accept is wired separately (Stage 3-1b, the applyToWikiPage CM bridge).

import { StateField, StateEffect, type EditorState, type Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from '@codemirror/view'
import { invertedEffects } from '@codemirror/commands'
import { usePendingChangesStore, type PendingChange } from '@/state/pendingChangesStore'
import { looseFindRange } from '@/lib/looseMatch'
import { renderInline } from '@/prototypes/widgets'

// Undo-link for accept: the accept's doc change (dispatched by the CM bridge) carries
// `acceptEffect.of(changeId)`. invertedEffects makes its undo carry `reopenEffect`, so
// Cmd-Z reverts the doc AND reopens the change (the mark comes back). The watcher below
// calls store.accept/reopen accordingly. Exported so CmEditor's bridge can tag the
// accept transaction.
export const acceptEffect = StateEffect.define<string>() // changeId
const reopenEffect = StateEffect.define<string>() // changeId

const acceptUndoLink = invertedEffects.of((tr) => {
  const out: StateEffect<unknown>[] = []
  for (const e of tr.effects) {
    if (e.is(acceptEffect)) out.push(reopenEffect.of(e.value))
    if (e.is(reopenEffect)) out.push(acceptEffect.of(e.value))
  }
  return out
})

const acceptUndoWatcher = EditorView.updateListener.of((u) => {
  for (const tr of u.transactions) {
    for (const e of tr.effects) {
      // Defer the store mutation: store.reopen triggers cmProofReview's subscription →
      // view.dispatch, which is illegal during an update. accept is idempotent.
      if (e.is(acceptEffect)) {
        const id = e.value
        queueMicrotask(() => usePendingChangesStore.getState().accept(id))
      } else if (e.is(reopenEffect)) {
        const id = e.value
        queueMicrotask(() => usePendingChangesStore.getState().reopen(id))
      }
    }
  }
})

type AnchoredEdit = {
  changeId: string
  editId: string
  from: number
  to: number // end of the matched `before`; === from would be a pure insertion (not used yet)
  after: string // replacement text ('' for a delete)
  kind: 'replace' | 'delete'
}

const setAnchored = StateEffect.define<AnchoredEdit[]>()

const anchoredField = StateField.define<AnchoredEdit[]>({
  create: () => [],
  update(value, tr) {
    let next = value
    if (tr.docChanged) {
      next = value
        .map((a) => ({ ...a, from: tr.changes.mapPos(a.from, 1), to: tr.changes.mapPos(a.to, -1) }))
        .filter((a) => a.to > a.from)
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
      }
      // 'add' / whole-file 'replace' (no `before`) → block-shaped, Stage 3-2.
    }
  }
  return out
}

const accept = (id: string) => usePendingChangesStore.getState().accept(id)
const reject = (id: string) => usePendingChangesStore.getState().reject(id)

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
    if (this.a.kind === 'replace' && this.a.after) {
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
      proofBtn('✕', 'cm-proof-reject', () => reject(this.a.changeId)),
    )
    return box
  }
  ignoreEvent() {
    return true
  }
}

function build(state: EditorState): DecorationSet {
  const ranges = state.field(anchoredField).flatMap((a) => [
    Decoration.mark({ class: 'cm-proof-old' }).range(a.from, a.to),
    Decoration.widget({ widget: new ReviewWidget(a), side: 1 }).range(a.to),
  ])
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
