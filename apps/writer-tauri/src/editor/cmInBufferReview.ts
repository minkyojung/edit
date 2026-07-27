// In-buffer AI-suggestion review (Cursor-style, Option B). Unlike the widget
// version, the proposal lives as REAL buffer text so editing is fully native:
//   • on arrival → insert each proposal's NEW text right under the OLD text
//     (planAdditional), record the red/green ranges, mark them RAW (renderers skip
//     them → proposal shows verbatim, tables don't render) and FREEZE the red.
//   • Keep → delete the red; the (edited) green stays and becomes saved content.
//   • Reject → delete the green; the red is restored.
//   • Save → the doc MINUS green ranges (CmEditor reads greenRangesForSave), so
//     disk only ever holds accepted text.
//
// Scope (step 2b): one batch of proposals at a time — if more arrive while a batch
// is still pending, they wait until the current batch is decided. Multi-batch
// concurrency is a later refinement.

import { StateField, StateEffect, EditorState, Transaction, type ChangeDesc, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from '@codemirror/view'
import { invertedEffects } from '@codemirror/commands'
import { usePendingChangesStore, type PendingChange } from '@/state/pendingChangesStore'
import { proofRawRangeProvider, type RawRange } from '@/editor/proofRawRanges'
import {
  planAdditional,
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
// Inverse of a decision: an UNDO un-decides the change (store → pending). Carries the
// ORIGINAL decision kind so REDO can re-emit that exact accept/reject — without it the
// inversion table was asymmetric (reopen had no inverse), so redo dropped the mat but
// never re-decided → the store stayed pending while the buffer showed the accepted text
// (a ghost "pending" card). It also means a redo tx carries the decision effect again,
// so isDecisionTx/shouldRemirror correctly re-mirror the saved body on redo.
const reopenEffect = StateEffect.define<{ id: string; was: 'accept' | 'reject' }>()
// Remap a mat's hunk positions through a doc change. Association is per-boundary:
//   • INWARD  (start +1, end −1): boundary insertions fall OUTSIDE the range — used
//     to track already-materialized ranges as the user types near them (a keystroke
//     at a boundary must not silently swallow into red/green).
//   • OUTWARD (start −1, end +1): a range that collapsed onto an insertion point
//     RE-EXPANDS to cover the inserted text — used when replaying an addMat over the
//     undo transaction that re-inserts the very red/green text the range describes.
type MatAssoc = { start: 1 | -1; end: 1 | -1 }
const INWARD: MatAssoc = { start: 1, end: -1 }
const OUTWARD: MatAssoc = { start: -1, end: 1 }
function remapMat(mat: ProposalMat, changes: ChangeDesc, a: MatAssoc): ProposalMat {
  return {
    changeId: mat.changeId,
    hunks: mat.hunks.map((h) => ({
      redFrom: changes.mapPos(h.redFrom, a.start),
      redTo: changes.mapPos(h.redTo, a.end),
      greenFrom: changes.mapPos(h.greenFrom, a.start),
      greenTo: changes.mapPos(h.greenTo, a.end),
      kind: h.kind,
    })),
  }
}

// Drop a change's materialized ranges from the field (after its red/green text was
// deleted by accept/reject). Applied AFTER the doc-change mapping in the same
// transaction, so the remaining changes stay correctly positioned.
const dropChange = StateEffect.define<string>()
// Re-add a previously-dropped change's ranges. Emitted by invertedEffects so an UNDO
// of an accept/reject restores matField in lockstep with the restored text. It CARRIES
// DOCUMENT POSITIONS, and its payload is stored in POST-decision coordinates (the same
// space as the inverse changes CM stores alongside it — see reviewUndoLink), so:
//   • `map` (INWARD) keeps the payload consistent with the stored changes while an
//     intervening addToHistory:false edit (the reconciler merging a new proposal)
//     makes CM remap the whole history event. Without it the offsets go stale → undo
//     restores the red text at the right place but matField points at the wrong
//     coordinates → savedBodyOf strips the wrong "green" into the saved body.
//   • the field re-expands it OUTWARD through the undo's own changes on apply (below).
const addMat = StateEffect.define<ProposalMat>({
  map: (mat, changes) => remapMat(mat, changes, INWARD),
})
// Materialize a freshly-planned proposal (the reconciler's INSERT step). Distinct
// from `addMat` because the two carry coordinates in DIFFERENT spaces, and one
// effect cannot serve both:
//   • addMat is an UNDO artifact. Its payload is in post-decision coordinates and
//     arrives alongside the undo's own re-insertion changes, so the field expands it
//     OUTWARD through them.
//   • putMat comes from planAdditional, whose mats are already in POST-insertion
//     coordinates, dispatched in the SAME transaction as those insertions. Mapping it
//     would be wrong twice over — and in fact threw, because a green range sits past
//     the end of the pre-change document (`Position N is out of range for changeset
//     of length M`). That exception escaped `reconcile`, so NO proposal ever appeared
//     in the buffer: the review card rendered from the store while the editor stayed
//     blank. Every replace/add proposal hit it.
// Never enters history (materialization is dispatched addToHistory:false), so it
// needs no `map` and is deliberately not inverted by reviewUndoLink.
const putMat = StateEffect.define<ProposalMat>()
// Test-only initial materialization; never dispatched in production and never flows
// through invertedEffects/history, so it needs no `map`.
const setMat = StateEffect.define<ProposalMat[]>()

const matField = StateField.define<ProposalMat[]>({
  create: () => [],
  update(value, tr) {
    let next = value
    if (tr.docChanged) {
      // Track existing ranges INWARD as the doc changes around them.
      next = value.map((m) => remapMat(m, tr.changes, INWARD))
    }
    for (const e of tr.effects) {
      if (e.is(setMat)) next = e.value
      else if (e.is(dropChange)) next = next.filter((m) => m.changeId !== e.value)
      else if (e.is(putMat)) {
        // Already in this transaction's POST-change space — take it verbatim.
        next = [...next.filter((m) => m.changeId !== e.value.changeId), e.value]
      } else if (e.is(addMat)) {
        // The payload is in this transaction's PRE-change (post-decision) space. Map it
        // OUTWARD through the transaction's own changes so a red/green range that was
        // collapsed onto the re-insertion point re-expands to cover the restored text.
        const mat = tr.docChanged ? remapMat(e.value, tr.changes, OUTWARD) : e.value
        next = [...next.filter((m) => m.changeId !== mat.changeId), mat]
      }
    }
    return next
  },
})

/** Green (proposal) ranges to EXCLUDE from the saved markdown — disk = accepted
 * state. CmEditor's save listener calls this. */
export function greenRangesForSave(state: EditorState): RawRange[] {
  return greenRangesOf(state.field(matField, false) ?? [])
}

/** The body to PERSIST for `state`: the doc minus the pending-green proposal
 * ranges (disk only ever holds accepted content). The single source of this
 * computation — CmEditor's getBody, its unmount checkpoint, and keep()'s
 * resolvedResult all go through here, and the save test asserts against it. */
export function savedBodyOf(state: EditorState): string {
  return stripRanges(state.doc.toString(), greenRangesForSave(state))
}

/** True when any transaction carries an accept/reject DECISION. Such a decision
 * flips a proposal between pending-green (EXCLUDED from greenRangesForSave) and
 * accepted (INCLUDED), so the saved body changes even when the doc text doesn't —
 * a pure-insertion accept has an empty red range and thus no doc change. CmEditor's
 * save listener must re-mirror on these, or an auto-accepted append to the open
 * note is silently dropped. */
export function isDecisionTx(transactions: readonly Transaction[]): boolean {
  return transactions.some((t) =>
    t.effects.some((e) => e.is(acceptEffect) || e.is(rejectEffect)),
  )
}

/** Whether CmEditor's save listener must re-mirror the saved body for a given
 * update: on a real doc change, OR on an accept/reject decision (which flips text
 * between pending-green EXCLUDED and accepted INCLUDED even with NO doc change —
 * bailing on `!docChanged` alone silently dropped auto-accepted appends). The
 * listener guard and the save test both call this, so the decision under test is
 * the production code. */
export function shouldRemirror(
  docChanged: boolean,
  transactions: readonly Transaction[],
): boolean {
  return docChanged || isDecisionTx(transactions)
}

// ── Undo wiring ────────────────────────────────────────────────────────────
const reviewUndoLink = invertedEffects.of((tr) => {
  const out: StateEffect<unknown>[] = []
  for (const e of tr.effects) {
    // Undo of accept/reject re-opens the change in the store; the kind is preserved so
    // the inverse-of-reopen (below) can re-emit the SAME decision on redo…
    if (e.is(acceptEffect)) out.push(reopenEffect.of({ id: e.value, was: 'accept' }))
    else if (e.is(rejectEffect)) out.push(reopenEffect.of({ id: e.value, was: 'reject' }))
    // …and the inverse of a reopen (an undo's effect) is re-applying the original
    // decision — so REDO re-accepts/re-rejects in the store AND re-mirrors the save.
    if (e.is(reopenEffect)) {
      out.push(e.value.was === 'accept' ? acceptEffect.of(e.value.id) : rejectEffect.of(e.value.id))
    }
    // …and restores its red/green ranges in matField, so the reconciler sees it's
    // still materialized and never re-inserts (the duplication bug). The mat is read
    // from startState (PRE-decision) so it still carries the red SPAN, then mapped
    // FORWARD through this decision's changes into POST-decision coordinates — the same
    // space as the inverse changes CM stores next to it, so a later intervening edit
    // maps the pair consistently (and never off the end of a shorter changeset). The
    // field re-expands it OUTWARD on undo. Deleted red/green collapses to a point here
    // and is recovered by that outward re-expansion.
    if (e.is(dropChange)) {
      const mat = tr.startState.field(matField).find((m) => m.changeId === e.value)
      if (mat) out.push(addMat.of(remapMat(mat, tr.changes, INWARD)))
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
      else if (e.is(reopenEffect)) queueMicrotask(() => store.reopen(e.value.id))
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
  //
  // Why this direct call AND the acceptEffect dispatched above (which makes
  // acceptUndoWatcher queue its OWN store.accept in a microtask) is NOT a
  // double-decision: this synchronous call runs first and flips the status to
  // 'accepted'; the watcher's microtask call then hits store.accept's
  // `status !== 'pending'` guard and no-ops WITHOUT clobbering resolvedResult.
  // reject() needs no resolvedResult, so it lets the watcher do the whole thing
  // (the asymmetry is intentional — don't "unify" it into a second dispatch).
  const resolved = savedBodyOf(view.state)
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
/** A change's current content, cheap to compare. Used both to decide whether
 * the store subscription below should even wake up the reconciler, and (per
 * materialized change) whether its already-inserted green text is stale. A
 * same-id re-push with unchanged content (the common case — most store
 * updates are unrelated fields ticking) must NOT retrigger a reconcile; a
 * same-id re-push with DIFFERENT content (e.g. a second same-turn tool call
 * merged into this staged proposal — see mergeEditIntoStagedBody) MUST. */
function contentFingerprint(c: PendingChange): string {
  return c.resolvedResult ?? c.edits[0]?.after ?? ''
}
const serialise = (pending: PendingChange[]) =>
  pending.map((c) => `${c.id}:${contentFingerprint(c)}`).join(' ')

export function cmInBufferReview(slug: string): Extension {
  // Content fingerprint recorded at the moment each change was last
  // materialized in THIS editor session, keyed by change id — so a change is
  // inserted exactly once per DISTINCT content (not once per id forever).
  // Survives undo (it's not CM state), so an undo that re-opens a change
  // (status → pending) can't make the reconciler re-insert it unchanged —
  // that re-insertion was the duplication this map originally guarded
  // against. Pruned when the change leaves the store entirely.
  const insertedFingerprint = new Map<string, string>()

  const reconcile = (view: EditorView) => {
    const store = usePendingChangesStore.getState()
    const mats = view.state.field(matField)
    const pending = store.pendingForPage(slug)
    const pendingIds = new Set(pending.map((c) => c.id))
    // Forget ids the store has fully dropped (pruned) so a genuinely new proposal
    // reusing... (ids are uuids, so this is just housekeeping).
    for (const id of insertedFingerprint.keys()) if (!store.byId[id]) insertedFingerprint.delete(id)

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

    // 1.5) REFRESH — a materialized proposal is STILL pending, but its
    //    content changed underneath the already-inserted green text (e.g. a
    //    second same-turn tool call merged into this SAME pendingId's staged
    //    body — see mergeEditIntoStagedBody — while this editor was already
    //    showing the first call's preview). Without this, the buffer would
    //    silently keep showing the stale text forever, and Keep would commit
    //    that stale text, discarding the merge. Remove the old red/green
    //    hunks entirely (both sides — not just one, unlike CLEANUP) and drop
    //    the recorded fingerprint so the INSERT step below re-materializes it
    //    fresh with the CURRENT content on the next pass.
    const stale = mats.filter(
      (m) =>
        pendingIds.has(m.changeId) &&
        store.byId[m.changeId] &&
        insertedFingerprint.get(m.changeId) !== contentFingerprint(store.byId[m.changeId]),
    )
    if (stale.length) {
      const dels: { from: number; to: number }[] = []
      const effects: StateEffect<unknown>[] = []
      for (const m of stale) {
        effects.push(dropChange.of(m.changeId))
        for (const h of m.hunks) {
          if (h.redTo > h.redFrom) dels.push({ from: h.redFrom, to: h.redTo })
          if (h.greenTo > h.greenFrom) dels.push({ from: h.greenFrom, to: h.greenTo })
        }
        insertedFingerprint.delete(m.changeId)
      }
      view.dispatch({
        changes: dels.sort((a, b) => a.from - b.from),
        effects,
        annotations: Transaction.addToHistory.of(false),
      })
      // Positions shifted and this change is no longer materialized — let a
      // fresh pass (INSERT, below) re-plan it against the now-current doc,
      // same deferral pattern the initial mount uses.
      requestAnimationFrame(() => reconcile(view))
      return
    }

    // 2) INSERT — materialize fresh proposals, even ALONGSIDE already-materialized
    //    ones: plan against the clean doc (real minus existing green) and translate
    //    the positions back into the real doc. `insertedFingerprint` keeps each
    //    change to exactly one insertion per distinct content (an undo-reopen
    //    can't re-insert it unchanged).
    const fresh = pending.filter((c) => !insertedFingerprint.has(c.id))
    if (!fresh.length) return
    const plan = planAdditional(view.state.doc.toString(), greenRangesOf(mats), fresh)
    if (!plan.mats.length) return
    fresh.forEach((c) => insertedFingerprint.set(c.id, contentFingerprint(c)))
    // Materializing is a SYSTEM action — keep it OUT of undo history so Cmd-Z hits
    // the user's own last edit, not "remove the proposal that just appeared".
    // putMat (not setMat) so existing proposals are preserved + position-mapped, and
    // not addMat: planAdditional's mats are already in post-insertion coordinates, so
    // addMat's OUTWARD remap would map a green range past the end of the pre-change
    // document and throw.
    view.dispatch({
      changes: plan.insertions,
      effects: plan.mats.map((m) => putMat.of(m)),
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
 * chat-panel accept path checks this (via `isChangeMaterializedInActiveCm`): when
 * true it lets the store flip the status and the reconciler's CLEANUP phase apply
 * the decision in-buffer, instead of the applier's whole-doc replace — ONE path,
 * so Cmd-Z restores the proposal consistently instead of duplicating it. */
export function isMaterialized(state: EditorState, changeId: string): boolean {
  return state.field(matField, false)?.some((m) => m.changeId === changeId) ?? false
}

// Test-only: the field + effects + undo link, so the "Reject → Undo restores the
// proposal (no duplicate)" invariant can be asserted headlessly.
export {
  matField as _matField,
  setMat as _setMat,
  dropChange as _dropChange,
  rejectEffect as _rejectEffect,
  acceptEffect as _acceptEffect,
  reviewUndoLink as _reviewUndoLink,
  freezeOldText as _freezeOldText,
}
