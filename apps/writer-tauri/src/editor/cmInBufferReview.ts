// In-buffer AI-suggestion review (Cursor-style, Option B). Unlike the widget
// version, the proposal lives as REAL buffer text so editing is fully native:
//   • on arrival → insert each proposal's NEW text right under the OLD text
//     (planProposals), record the red/green ranges, mark them RAW (renderers skip
//     them → proposal shows verbatim, tables don't render) and FREEZE the red.
//   • Keep → delete the red; the (edited) green stays and becomes saved content.
//   • Reject → delete the green; the red is restored.
//   • Save → the doc MINUS green ranges (CmEditor reads greenRangesForSave), so
//     disk only ever holds accepted text.
//
// Scope (step 2b): one batch of proposals at a time — if more arrive while a batch
// is still pending, they wait until the current batch is decided. Multi-batch
// concurrency is a later refinement.

import { StateField, StateEffect, EditorState, Transaction, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from '@codemirror/view'
import { invertedEffects } from '@codemirror/commands'
import { usePendingChangesStore } from '@/state/pendingChangesStore'
import { proofRawRangeProvider, type RawRange } from '@/editor/proofRawRanges'
import {
  planProposals,
  greenRangesOf,
  redRangesOf,
  stripRanges,
  type ProposalMat,
} from '@/editor/proposalPlan'

// Accept/reject carry the change id and land in CM history so Cmd-Z works; their
// inverse is "reopen" (un-decide). Exported so CmEditor's chat-panel bridges can
// still tag transactions (kept compatible with the widget version's contract).
export const acceptEffect = StateEffect.define<string>()
export const rejectEffect = StateEffect.define<string>()
const reopenEffect = StateEffect.define<string>()
// Drop a change's materialized ranges from the field (after its red/green text was
// deleted by accept/reject). Applied AFTER the doc-change mapping in the same
// transaction, so the remaining changes stay correctly positioned.
const dropChange = StateEffect.define<string>()
// Re-add a previously-dropped change's ranges. Emitted by invertedEffects so an
// UNDO of an accept/reject restores matField in lockstep with the restored text.
const addMat = StateEffect.define<ProposalMat>()
const setMat = StateEffect.define<ProposalMat[]>()

const matField = StateField.define<ProposalMat[]>({
  create: () => [],
  update(value, tr) {
    let next = value
    if (tr.docChanged) {
      next = value
        .map((m) => ({
          changeId: m.changeId,
          hunks: m.hunks.map((h) => ({
            redFrom: tr.changes.mapPos(h.redFrom, 1),
            redTo: tr.changes.mapPos(h.redTo, -1),
            greenFrom: tr.changes.mapPos(h.greenFrom, 1),
            greenTo: tr.changes.mapPos(h.greenTo, -1),
            kind: h.kind,
          })),
        }))
    }
    for (const e of tr.effects) {
      if (e.is(setMat)) next = e.value
      else if (e.is(dropChange)) next = next.filter((m) => m.changeId !== e.value)
      else if (e.is(addMat)) next = [...next.filter((m) => m.changeId !== e.value.changeId), e.value]
    }
    return next
  },
})

/** Green (proposal) ranges to EXCLUDE from the saved markdown — disk = accepted
 * state. CmEditor's save listener calls this. */
export function greenRangesForSave(state: EditorState): RawRange[] {
  return greenRangesOf(state.field(matField, false) ?? [])
}

// ── Undo wiring ────────────────────────────────────────────────────────────
const reviewUndoLink = invertedEffects.of((tr) => {
  const out: StateEffect<unknown>[] = []
  for (const e of tr.effects) {
    // Undo of accept/reject re-opens the change in the store…
    if (e.is(acceptEffect) || e.is(rejectEffect)) out.push(reopenEffect.of(e.value))
    // …and restores its red/green ranges in matField, so the reconciler sees it's
    // still materialized and never re-inserts (the duplication bug).
    if (e.is(dropChange)) {
      const mat = tr.startState.field(matField).find((m) => m.changeId === e.value)
      if (mat) out.push(addMat.of(mat))
    }
    // The inverse of re-adding (an undo's effect) is dropping again — so REDO of
    // an accept/reject drops the change once more, keeping matField ↔ text in step.
    if (e.is(addMat)) out.push(dropChange.of(e.value.changeId))
  }
  return out
})
const acceptUndoWatcher = EditorView.updateListener.of((u) => {
  for (const tr of u.transactions) {
    for (const e of tr.effects) {
      const store = usePendingChangesStore.getState()
      if (e.is(acceptEffect)) queueMicrotask(() => store.accept(e.value))
      else if (e.is(rejectEffect)) queueMicrotask(() => store.reject(e.value))
      else if (e.is(reopenEffect)) queueMicrotask(() => store.reopen(e.value))
    }
  }
})

// ── Accept / Reject (buffer edits) ───────────────────────────────────────────
function keep(view: EditorView, changeId: string) {
  const mine = view.state.field(matField).find((m) => m.changeId === changeId)
  if (!mine) return
  // Delete the RED (old) text; the green proposal stays and becomes permanent.
  const dels = mine.hunks
    .filter((h) => h.redTo > h.redFrom)
    .map((h) => ({ from: h.redFrom, to: h.redTo }))
    .sort((a, b) => a.from - b.from)
  view.dispatch({ changes: dels, effects: [dropChange.of(changeId), acceptEffect.of(changeId)] })
  // After the dispatch the doc + field are updated; the saved text is the doc
  // minus the REMAINING green. Pass it as resolvedResult so the store applier
  // (which also fires on accept) is a no-op (oldMd === newMd) — no double apply.
  const resolved = stripRanges(view.state.doc.toString(), greenRangesForSave(view.state))
  usePendingChangesStore.getState().accept(changeId, resolved)
}

function reject(view: EditorView, changeId: string) {
  const mine = view.state.field(matField).find((m) => m.changeId === changeId)
  if (!mine) return
  // Delete the GREEN (proposal); the red (original) text is restored. ONE
  // undoable transaction — the rejectEffect drives store.reject via the watcher
  // (mirrors keep()). A second dispatch here would split the undo and make Cmd-Z
  // appear to do nothing.
  const dels = mine.hunks
    .filter((h) => h.greenTo > h.greenFrom)
    .map((h) => ({ from: h.greenFrom, to: h.greenTo }))
    .sort((a, b) => a.from - b.from)
  view.dispatch({ changes: dels, effects: [dropChange.of(changeId), rejectEffect.of(changeId)] })
}

// ── Decorations ──────────────────────────────────────────────────────────────
class ButtonsWidget extends WidgetType {
  constructor(readonly changeId: string) {
    super()
  }
  eq(o: ButtonsWidget) {
    return o.changeId === this.changeId
  }
  toDOM(view: EditorView) {
    const box = document.createElement('span')
    box.className = 'cm-proof-review'
    const btn = (label: string, cls: string, fn: () => void) => {
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
    box.append(
      btn('✓', 'cm-proof-keep', () => keep(view, this.changeId)),
      btn('✕', 'cm-proof-reject', () => reject(view, this.changeId)),
    )
    return box
  }
  ignoreEvent() {
    return true
  }
}

function build(state: EditorState): DecorationSet {
  const out: Range<Decoration>[] = []
  for (const m of state.field(matField)) {
    let end = -1
    for (const h of m.hunks) {
      if (h.redTo > h.redFrom) out.push(Decoration.mark({ class: 'cm-proof-old' }).range(h.redFrom, h.redTo))
      if (h.greenTo > h.greenFrom) out.push(Decoration.mark({ class: 'cm-proof-new' }).range(h.greenFrom, h.greenTo))
      end = Math.max(end, h.redTo, h.greenTo)
    }
    if (end >= 0) out.push(Decoration.widget({ widget: new ButtonsWidget(m.changeId), side: 1 }).range(end))
  }
  return Decoration.set(out, true)
}

// ── Freeze the red (old) text — same rule as Stage 1 ─────────────────────────
const freezeOldText = EditorState.changeFilter.of((tr) => {
  if (!(tr.isUserEvent('input') || tr.isUserEvent('delete'))) return true
  const mats = tr.startState.field(matField, false)
  if (!mats?.length) return true
  const ranges: number[] = []
  for (const r of redRangesOf(mats)) ranges.push(r.from, r.to)
  return ranges.length ? ranges.sort((a, b) => a - b) : true
})

const proofTheme = EditorView.theme({
  '.cm-proof-old': {
    textDecoration: 'line-through',
    color: 'var(--muted-foreground)',
    background: 'color-mix(in oklch, var(--destructive, crimson) 14%, transparent)',
    borderRadius: '2px',
  },
  '.cm-proof-new': {
    background: 'color-mix(in oklch, #2ecc71 20%, transparent)',
    borderRadius: '2px',
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

// ── Reconciler: materialize one batch of pending proposals ───────────────────
const serialise = (pending: { id: string }[]) => pending.map((c) => c.id).join('|')

export function cmInBufferReview(slug: string): Extension {
  // Ids ever materialized in THIS editor session, so a change is inserted EXACTLY
  // once. Survives undo (it's not CM state), so an undo that re-opens a change
  // (status → pending) can't make the reconciler re-insert it — that re-insertion
  // was the duplication. Pruned when the change leaves the store entirely.
  const everInserted = new Set<string>()

  const reconcile = (view: EditorView) => {
    const store = usePendingChangesStore.getState()
    const mats = view.state.field(matField)
    const pendingIds = new Set(store.pendingForPage(slug).map((c) => c.id))
    // Forget ids the store has fully dropped (pruned) so a genuinely new proposal
    // reusing... (ids are uuids, so this is just housekeeping).
    for (const id of everInserted) if (!store.byId[id]) everInserted.delete(id)

    // 1) CLEANUP — a materialized proposal was DECIDED elsewhere (e.g. the chat
    //    panel). The in-buffer review OWNS the buffer: rejected → delete the green
    //    (red original restored); accepted → delete the RED (the edited green
    //    becomes the accepted text). Undoable + tagged so Cmd-Z restores the
    //    proposal (addMat ↔ dropChange, reopen ↔ accept/rejectEffect) consistently.
    const decided = mats.filter((m) => !pendingIds.has(m.changeId))
    if (decided.length) {
      const dels: { from: number; to: number }[] = []
      const effects: StateEffect<unknown>[] = []
      for (const m of decided) {
        const accepted = store.byId[m.changeId]?.status === 'accepted'
        effects.push(dropChange.of(m.changeId), accepted ? acceptEffect.of(m.changeId) : rejectEffect.of(m.changeId))
        for (const h of m.hunks) {
          const r = accepted ? { from: h.redFrom, to: h.redTo } : { from: h.greenFrom, to: h.greenTo }
          if (r.to > r.from) dels.push(r)
        }
      }
      view.dispatch({ changes: dels.sort((a, b) => a.from - b.from), effects })
      return
    }

    // 2) INSERT — one batch at a time; only when nothing is materialized (clean
    //    doc) AND the change was never inserted before (the re-insert guard).
    if (mats.length) return
    const fresh = store.pendingForPage(slug).filter((c) => !everInserted.has(c.id))
    if (!fresh.length) return
    const plan = planProposals(view.state.doc.toString(), fresh)
    if (!plan.mats.length) return
    fresh.forEach((c) => everInserted.add(c.id))
    // Materializing is a SYSTEM action — keep it OUT of undo history so Cmd-Z hits
    // the user's own last edit, not "remove the proposal that just appeared".
    view.dispatch({
      changes: plan.insertions,
      effects: [setMat.of(plan.mats)],
      annotations: Transaction.addToHistory.of(false),
    })
  }

  const sub = ViewPlugin.fromClass(
    class {
      unsub: () => void
      last: string
      constructor(readonly view: EditorView) {
        this.last = serialise(usePendingChangesStore.getState().pendingForPage(slug))
        requestAnimationFrame(() => reconcile(view))
        this.unsub = usePendingChangesStore.subscribe(() => {
          const cur = serialise(usePendingChangesStore.getState().pendingForPage(slug))
          if (cur === this.last) return
          this.last = cur
          reconcile(view)
        })
      }
      destroy() {
        this.unsub()
      }
    },
  )

  return [
    matField,
    freezeOldText,
    EditorView.decorations.compute([matField], build),
    proofRawRangeProvider.of((state) => {
      const mats = state.field(matField, false) ?? []
      return [...redRangesOf(mats), ...greenRangesOf(mats)]
    }),
    proofTheme,
    sub,
    reviewUndoLink,
    acceptUndoWatcher,
  ]
}

/** Is `changeId` currently shown as an in-buffer proposal in this editor? The
 * chat-panel accept path checks this and routes through `acceptInBuffer` (the same
 * keep() the inline ✓ uses) instead of the applier's whole-doc replace — ONE path,
 * so Cmd-Z restores the proposal consistently instead of duplicating it. */
export function isMaterialized(state: EditorState, changeId: string): boolean {
  return state.field(matField, false)?.some((m) => m.changeId === changeId) ?? false
}

/** Accept an in-buffer proposal (delete red, keep the edited green) — the chat
 * panel delegates here for materialized changes so both buttons share one path. */
export const acceptInBuffer = keep

// Test-only: the field + effects + undo link, so the "Reject → Undo restores the
// proposal (no duplicate)" invariant can be asserted headlessly.
export {
  matField as _matField,
  setMat as _setMat,
  dropChange as _dropChange,
  rejectEffect as _rejectEffect,
  acceptEffect as _acceptEffect,
  reviewUndoLink as _reviewUndoLink,
}
