// Headless proof of the IME freeze: while composing, the decoration field must
// NOT rebuild (frozen reference); on compositionend it rebuilds. (The real
// composition/keydown behavior needs a manual IME check — see the plan doc.)

import { describe, expect, it } from 'vitest'
import { EditorState, type StateField } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { composingField, setComposing } from './imeComposition'
import { livePreview } from './livePreview'

// livePreview's runtime value IS the lpField StateField (exported as Extension).
const lpField = livePreview as unknown as StateField<unknown>

function stateFor(doc: string) {
  return EditorState.create({
    // composingField before livePreview so it updates first.
    doc,
    extensions: [markdown({ extensions: [GFM] }), composingField, livePreview],
  })
}

describe('IME composition freeze', () => {
  it('freezes decorations while composing, rebuilds on compositionend', () => {
    let state = stateFor('- item')
    const before = state.field(lpField)

    state = state.update({ effects: setComposing.of(true) }).state // start
    state = state.update({ changes: { from: 6, insert: 'X' } }).state // edit while composing
    expect(state.field(lpField)).toBe(before) // frozen — no rebuild

    state = state.update({ effects: setComposing.of(false) }).state // end
    expect(state.field(lpField)).not.toBe(before) // rebuilt
  })

  it('normal edits (not composing) rebuild as usual', () => {
    let state = stateFor('- item')
    const before = state.field(lpField)
    state = state.update({ changes: { from: 6, insert: 'Y' } }).state
    expect(state.field(lpField)).not.toBe(before)
  })
})
