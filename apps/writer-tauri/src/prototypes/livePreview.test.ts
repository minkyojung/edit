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
import { ImageWidget, TableWidget, BulletWidget } from './widgets'
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

  it('reveal is PER-CONSTRUCT (range-level), not per-line', () => {
    // Two bolds on one line. Caret inside the first must reveal ONLY the
    // first's `**` — the second stays hidden (the whole point vs line-level).
    const doc = '**a** **b** x' // trailing ` x` gives a caret spot outside both
    const range = [{ from: 0, to: doc.length }]
    // A hide is a Decoration.replace({}) — no class, no widget.
    const hideCount = (d: ReturnType<typeof buildDecorations>) =>
      d.decos.filter((r) => !r.value.spec.class && !r.value.spec.widget).length

    const caretOutside = stateAt(doc, doc.length) // after "x" — outside both
    const caretInFirst = stateAt(doc, 2) // inside first bold

    expect(hideCount(buildDecorations(caretOutside, range, new Set()))).toBe(4) // both `**` pairs hidden
    expect(hideCount(buildDecorations(caretInFirst, range, new Set()))).toBe(2) // only the 2nd bold hidden
  })

  it('list marker renders a bullet only once COMPLETE and caret is off it', () => {
    const bulletWidget = (d: ReturnType<typeof buildDecorations>) =>
      d.decos.some((r) => r.value.spec.widget instanceof BulletWidget)

    // Bare `-` (no space) → not a list marker yet → no bullet.
    expect(bulletWidget(buildDecorations(stateAt('-', 1), [{ from: 0, to: 1 }], new Set()))).toBe(false)

    // `- item` with caret ON the marker → raw (no bullet).
    expect(
      bulletWidget(buildDecorations(stateAt('- item', 1), [{ from: 0, to: 6 }], new Set())),
    ).toBe(false)

    // `- item` with caret in the content → bullet renders.
    expect(
      bulletWidget(buildDecorations(stateAt('- item', 4), [{ from: 0, to: 6 }], new Set())),
    ).toBe(true)
  })
})

function stateAt(doc: string, pos: number): EditorState {
  const state = EditorState.create({
    doc,
    selection: { anchor: pos },
    extensions: [markdown({ extensions: [GFM] })],
  })
  ensureSyntaxTree(state, doc.length, 5000)
  return state
}
