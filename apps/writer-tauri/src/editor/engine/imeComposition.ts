// IME (composition) safety — the canonical rule: while the user is composing
// (Korean/Japanese/Chinese/dead-keys), DON'T rebuild decorations over the
// composing range, or the composition DOM gets reset and input breaks (the
// "type then Enter does nothing" bug). We track composition via a StateField
// driven by compositionstart/end, and the decoration fields freeze their
// output while it's true, rebuilding once when it ends.
//
// StateFields can't read view.composing, so we surface it INTO state here and
// the fields read `isComposing(tr.state)`.

import { EditorView } from '@codemirror/view'
import {
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Transaction,
} from '@codemirror/state'

export const setComposing = StateEffect.define<boolean>()

export const composingField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setComposing)) value = e.value
    return value
  },
})

/** Composing right now (read in a field's update via tr.state). */
export function isComposing(state: EditorState): boolean {
  return state.field(composingField, false) ?? false
}

/** This transaction just ENDED composition → rebuild decorations once. */
export function compositionEnded(tr: Transaction): boolean {
  return tr.effects.some((e) => e.is(setComposing) && e.value === false)
}

// Surface composition lifecycle into state. compositionend dispatches an
// effects-only transaction (no doc change) so it can't disrupt the commit;
// CM's own composed-text insertion follows and rebuilds normally.
const watcher = EditorView.domEventHandlers({
  compositionstart(_event, view) {
    view.dispatch({ effects: setComposing.of(true) })
  },
  compositionend(_event, view) {
    view.dispatch({ effects: setComposing.of(false) })
  },
})

// Order matters: composingField must update before the decoration fields that
// read it, so list it first in the editor config.
export const imeComposition: Extension = [composingField, watcher]
