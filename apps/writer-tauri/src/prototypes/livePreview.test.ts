// Headless correctness check for the Live Preview decoration engine.
// Doesn't judge looks (that's the browser's job) — it catches the two
// runtime risks that typecheck can't: RangeSet ordering throws and
// Lezer node-name mismatches (a wrong name silently produces 0 decos).

import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { Decoration } from '@codemirror/view'
import { ensureSyntaxTree } from '@codemirror/language'
import { markdown } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { buildDecorations } from './livePreview'
import { ImageWidget, TableWidget } from './widgets'
import { SAMPLE } from './sample'

function stateFor(doc: string): EditorState {
  const state = EditorState.create({ doc, extensions: [markdown({ extensions: [GFM] })] })
  // Force a complete parse so syntaxTree() inside buildDecorations is full.
  ensureSyntaxTree(state, doc.length, 5000)
  return state
}

describe('live preview decoration engine (headless)', () => {
  const state = stateFor(SAMPLE)
  const full = [{ from: 0, to: state.doc.length }]

  it('builds a valid (orderable) decoration set without throwing', () => {
    const { decos, atomic } = buildDecorations(state, full, new Set())
    expect(decos.length).toBeGreaterThan(0)
    // Decoration.set(arr, true) sorts + validates ordering — this is where
    // a bad mix of line/mark/replace would throw.
    expect(() => Decoration.set(decos, true)).not.toThrow()
    expect(() => Decoration.set(atomic, true)).not.toThrow()
  })

  it('recognizes the key constructs (node names are correct)', () => {
    const { decos } = buildDecorations(state, full, new Set())
    const specs = decos.map((r) => r.value.spec)
    const hasWidget = (W: unknown) =>
      specs.some((s) => s.widget && s.widget instanceof (W as never))
    const hasClass = (c: string) => specs.some((s) => s.class === c || s.attributes?.class === c)

    expect(hasWidget(ImageWidget), 'image widget').toBe(true)
    expect(hasWidget(TableWidget), 'table widget').toBe(true)
    expect(hasClass('cm-h1') || specs.some((s) => s.class?.startsWith('cm-h')), 'heading line').toBe(true)
    expect(specs.some((s) => s.class === 'cm-wikilink'), 'wikilink mark').toBe(true)
    expect(specs.some((s) => s.class === 'cm-strong'), 'bold mark').toBe(true)
  })

  it('reveal rule: active lines produce fewer hides than inactive', () => {
    const inactive = buildDecorations(state, full, new Set())
    const allLines = new Set<number>()
    for (let n = 1; n <= state.doc.lines; n++) allLines.add(n)
    const active = buildDecorations(state, full, allLines)
    // Every line active → nothing hidden/widgetized, so far fewer decos.
    expect(active.decos.length).toBeLessThan(inactive.decos.length)
    expect(active.atomic.length).toBe(0)
  })
})
