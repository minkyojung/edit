// SPIKE — CM6-native proof/suggestion mark system (de-risk the AI-collaboration
// port). Reachable at #/dev/proofmark.
//
// The whole question: can the "AI suggests an edit, anchored to a text range,
// rendered inline, Keep/Reject" system be CM-native AND track edits EXACTLY without
// the PM+Yjs fuzzy quote-search?
//
// Canonical CM6 shape (from the research):
//   • StateField<Suggestion[]>  = single source of truth.
//   • update(): map each range through `tr.changes` every transaction → EXACT live
//     re-anchoring, no text search. (Fuzzy quote search is only needed on file
//     reload — out of scope for this spike.)
//   • Derived decorations: Decoration.mark (strike the old text) + Decoration.widget
//     (the suggested text + Keep/Reject buttons).
//   • StateEffects: add / accept / reject. Accept = doc change + drop mark in ONE
//     transaction (atomic, single undo). Reject = drop mark only.

import { useEffect, useRef } from 'react'
import { EditorState, StateEffect, StateField, Transaction, type Extension } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, keymap, drawSelection, type DecorationSet } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, invertedEffects } from '@codemirror/commands'
import { cmPrototypeTheme } from '../cmTheme'

type Suggestion = {
  id: string
  from: number
  to: number // existing text range to replace (to > from)
  after: string // suggested replacement text
}

// ── Effects ─────────────────────────────────────────────────────────────────
// addSuggestion carries a positioned range, so it MUST provide `map`: when CM stores
// this effect for undo (invertedEffects) and the doc changes before the undo runs,
// the effect's range has to be mapped through those changes — otherwise undo would
// re-add the mark at a stale position (or a collapsed range that gets filtered out).
const addSuggestion = StateEffect.define<Suggestion>({
  map: (s, change) => ({ ...s, from: change.mapPos(s.from, 1), to: change.mapPos(s.to, -1) }),
})
const acceptSuggestion = StateEffect.define<string>() // id — no position, no map needed
const rejectSuggestion = StateEffect.define<string>() // id

// ── State field = single source of truth ────────────────────────────────────
const suggestionField = StateField.define<Suggestion[]>({
  create: () => [],
  update(value, tr) {
    if (!tr.docChanged && tr.effects.length === 0) return value
    // EXACT re-anchor: map every range through this transaction's changes. `from`
    // with assoc +1 / `to` with assoc -1 → edge insertions don't grow the mark;
    // edits INSIDE it adjust it; a fully-deleted range collapses and is dropped.
    let next = tr.docChanged
      ? value
          .map((s) => ({ ...s, from: tr.changes.mapPos(s.from, 1), to: tr.changes.mapPos(s.to, -1) }))
          .filter((s) => s.to > s.from)
      : [...value]
    for (const e of tr.effects) {
      if (e.is(addSuggestion)) next.push(e.value)
      if (e.is(acceptSuggestion) || e.is(rejectSuggestion)) next = next.filter((s) => s.id !== e.value)
    }
    return next
  },
})

// ── Operations ──────────────────────────────────────────────────────────────
function accept(view: EditorView, id: string) {
  const s = view.state.field(suggestionField).find((x) => x.id === id)
  if (!s) return
  // Apply the suggested change AND drop the mark in ONE transaction → atomic + one
  // undo step. Other marks survive because update() maps them through tr.changes.
  view.dispatch({ changes: { from: s.from, to: s.to, insert: s.after }, effects: acceptSuggestion.of(id) })
}
function reject(view: EditorView, id: string) {
  view.dispatch({ effects: rejectSuggestion.of(id) }) // no doc change — just drop the mark
}

// ── Derived decorations (rendering only) ────────────────────────────────────
class ReviewWidget extends WidgetType {
  constructor(readonly s: Suggestion) {
    super()
  }
  eq(o: ReviewWidget) {
    return o.s.id === this.s.id && o.s.after === this.s.after
  }
  toDOM(view: EditorView) {
    const box = document.createElement('span')
    box.className = 'cm-proof-review'
    const ins = document.createElement('span')
    ins.className = 'cm-proof-new'
    ins.textContent = this.s.after
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
      ins,
      btn('✓', 'cm-proof-keep', () => accept(view, this.s.id)),
      btn('✕', 'cm-proof-reject', () => reject(view, this.s.id)),
    )
    return box
  }
  ignoreEvent() {
    return true // buttons handle their own clicks; keep CM out of it
  }
}

function buildDecorations(suggestions: Suggestion[]): DecorationSet {
  const ranges = suggestions.flatMap((s) => [
    Decoration.mark({ class: 'cm-proof-old' }).range(s.from, s.to),
    Decoration.widget({ widget: new ReviewWidget(s), side: 1 }).range(s.to),
  ])
  return Decoration.set(ranges, true)
}

const proofDecorations = EditorView.decorations.compute([suggestionField], (state) =>
  buildDecorations(state.field(suggestionField)),
)

// ── Make accept/reject UNDOABLE — restore the mark on Cmd-Z ──────────────────
// By default StateEffects aren't in the undo history, so undoing an accept reverted
// the text but not the mark. invertedEffects adds, to a transaction's INVERSE, the
// effects that bring the suggestion back. (A pure-effect reject is also recorded by
// history once it carries inverted effects, so it becomes undoable too.)
const proofInvertedEffects = invertedEffects.of((tr) => {
  const inverted: StateEffect<unknown>[] = []
  for (const e of tr.effects) {
    if (e.is(acceptSuggestion) || e.is(rejectSuggestion)) {
      const s = tr.startState.field(suggestionField).find((x) => x.id === e.value)
      if (s) inverted.push(addSuggestion.of(s)) // undo of accept/reject → re-add the mark
    }
    if (e.is(addSuggestion)) {
      inverted.push(rejectSuggestion.of(e.value.id)) // undo of add → remove the mark
    }
  }
  return inverted
})

const proofTheme = EditorView.theme({
  '.cm-proof-old': {
    textDecoration: 'line-through',
    color: 'var(--muted-foreground)',
    background: 'color-mix(in oklch, var(--destructive, crimson) 14%, transparent)',
    borderRadius: '2px',
  },
  '.cm-proof-review': { whiteSpace: 'nowrap' },
  '.cm-proof-new': {
    color: 'var(--foreground)',
    background: 'color-mix(in oklch, #2ecc71 22%, transparent)',
    borderRadius: '2px',
    padding: '0 0.15em',
    marginLeft: '0.15em',
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

const proofMarks: Extension = [suggestionField, proofDecorations, proofInvertedEffects, proofTheme]

const SAMPLE = `# Proof-mark spike

CM-native suggestion marks. Two AI suggestions are pre-seeded below: the struck-
through red text is the original, the green text is the proposed replacement, with
✓ Keep / ✕ Reject buttons.

TEST the make-or-break: EDIT the text around/inside a suggestion (type before it,
delete inside it, add a line above) — the mark + buttons must follow EXACTLY, with
NO drift and NO re-search. Then ✓ applies the change + removes the mark in one undo
step; ✕ just removes the mark. Cmd-Z should undo cleanly.

The quick brown fox jumps over the lazy dog near the river bank at dawn.

Edit freely up here — the suggestions below should not move incorrectly.
`

export default function ProofMarkSpike() {
  const hostRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const parent = hostRef.current
    if (!parent) return
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: SAMPLE,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          drawSelection(),
          EditorView.lineWrapping,
          proofMarks,
          cmPrototypeTheme,
        ],
      }),
    })
    // Seed two suggestions by locating words in the doc text.
    const doc = view.state.doc.toString()
    const seed = (word: string, after: string, id: string): Suggestion | null => {
      const from = doc.indexOf(word)
      return from < 0 ? null : { id, from, to: from + word.length, after }
    }
    const seeds = [seed('quick', 'fast', 's1'), seed('lazy', 'sleepy', 's2')].filter(Boolean) as Suggestion[]
    // Keep the seed OUT of undo history (else the first Cmd-Z would remove the marks).
    view.dispatch({
      effects: seeds.map((s) => addSuggestion.of(s)),
      annotations: Transaction.addToHistory.of(false),
    })
    return () => view.destroy()
  }, [])
  return (
    <div style={{ position: 'fixed', inset: 0, overflow: 'auto', background: 'var(--background)', color: 'var(--foreground)' }}>
      <div style={{ padding: '10px 16px', fontSize: 13, color: 'var(--muted-foreground)', borderBottom: '1px solid var(--border)' }}>
        PROOF-MARK SPIKE — CM-native suggestions (StateField + decorations + effects)
      </div>
      <div className="cm-prototype" ref={hostRef} />
    </div>
  )
}
