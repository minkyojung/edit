// CM-native proof / suggestion mark system (shared). A StateField is the single
// source of truth; decorations are DERIVED (strike old / show new / Keep-Reject);
// StateEffects drive add/accept/reject. Live re-anchoring is EXACT via
// set.map(tr.changes); accept/reject are undoable via invertedEffects. See
// ProofMarkSpike (#/dev/proofmark) for the isolated proof, ProofRichSpike
// (#/dev/proofrich) for it layered over the full markdown live-preview.

import { StateEffect, StateField, type Extension } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import { invertedEffects } from '@codemirror/commands'

export type Suggestion = {
  id: string
  from: number
  to: number // existing text range to replace (to > from)
  after: string // suggested replacement text
}

// addSuggestion carries a positioned range, so it MUST provide `map`: when CM stores
// it for undo (invertedEffects) and the doc changes before the undo runs, the range
// has to be mapped through those changes.
export const addSuggestion = StateEffect.define<Suggestion>({
  map: (s, change) => ({ ...s, from: change.mapPos(s.from, 1), to: change.mapPos(s.to, -1) }),
})
export const acceptSuggestion = StateEffect.define<string>() // id
export const rejectSuggestion = StateEffect.define<string>() // id

export const suggestionField = StateField.define<Suggestion[]>({
  create: () => [],
  update(value, tr) {
    if (!tr.docChanged && tr.effects.length === 0) return value
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

function acceptOp(view: EditorView, id: string) {
  const s = view.state.field(suggestionField).find((x) => x.id === id)
  if (!s) return
  view.dispatch({ changes: { from: s.from, to: s.to, insert: s.after }, effects: acceptSuggestion.of(id) })
}
function rejectOp(view: EditorView, id: string) {
  view.dispatch({ effects: rejectSuggestion.of(id) })
}

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
      btn('✓', 'cm-proof-keep', () => acceptOp(view, this.s.id)),
      btn('✕', 'cm-proof-reject', () => rejectOp(view, this.s.id)),
    )
    return box
  }
  ignoreEvent() {
    return true
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

const proofInvertedEffects = invertedEffects.of((tr) => {
  const inverted: StateEffect<unknown>[] = []
  for (const e of tr.effects) {
    if (e.is(acceptSuggestion) || e.is(rejectSuggestion)) {
      const s = tr.startState.field(suggestionField).find((x) => x.id === e.value)
      if (s) inverted.push(addSuggestion.of(s))
    }
    if (e.is(addSuggestion)) inverted.push(rejectSuggestion.of(e.value.id))
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

export const proofMarks: Extension = [suggestionField, proofDecorations, proofInvertedEffects, proofTheme]

/** Build a replace-suggestion by locating `word` in the doc text (first match). */
export function seedSuggestion(docText: string, word: string, after: string, id: string): Suggestion | null {
  const from = docText.indexOf(word)
  return from < 0 ? null : { id, from, to: from + word.length, after }
}
