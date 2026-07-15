// Task checkbox is a REAL widget (CheckboxWidget), not a CSS `::after` + coordinate
// hit-test. Pin the decoration shape headlessly: caret OFF the `- [ ]` prefix →
// a replace-with-widget carrying the checked state; caret ON it → a plain mark
// (raw, editable). The click toggle itself needs a real browser (posAtDOM), so it
// isn't asserted here.

import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { ensureSyntaxTree } from '@codemirror/language'
import { _buildDecos } from './livePreview'

function boxDeco(doc: string, caret: number) {
  const state = EditorState.create({
    doc,
    selection: { anchor: caret },
    extensions: [markdown({ extensions: [GFM] })],
  })
  ensureSyntaxTree(state, doc.length, 5000)
  // The `- [ ]` prefix occupies [0,5] on a top-level task line.
  return _buildDecos(state, [{ from: 0, to: state.doc.length }]).find((r) => r.from === 0 && r.to === 5)
}

describe('task checkbox decoration', () => {
  it('caret off the marker → replace widget, unchecked', () => {
    const spec = boxDeco('- [ ] task', 8)?.value.spec as { widget?: { constructor: { name: string }; checked: boolean } }
    expect(spec?.widget?.constructor.name).toBe('CheckboxWidget')
    expect(spec?.widget?.checked).toBe(false)
  })

  it('checked task → widget.checked true', () => {
    const spec = boxDeco('- [x] task', 8)?.value.spec as { widget?: { checked: boolean } }
    expect(spec?.widget?.checked).toBe(true)
  })

  it('caret on the marker → plain mark (raw, editable), no widget', () => {
    const spec = boxDeco('- [ ] task', 2)?.value.spec as { widget?: unknown }
    expect(spec).toBeTruthy()
    expect(spec.widget).toBeFalsy()
  })
})
