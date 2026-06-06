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
import { ImageWidget, TableWidget, CheckboxWidget } from './widgets'
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

  it('bullet reveal: collapsed caret reveals, but a span selection does not', () => {
    // The bullet is drawn by `.cm-list-bullet::before`, so "rendered" == the
    // line carries the cm-list-bullet decoration (and the `- ` is hidden).
    const hasBullet = (d: ReturnType<typeof buildDecorations>) =>
      d.decos.some((r) => (r.value.spec.class as string | undefined)?.includes('cm-list-bullet'))

    // Just-typed `-`, caret on the marker → raw (no structural bullet).
    expect(hasBullet(buildDecorations(stateAt('-', 1), [{ from: 0, to: 1 }], new Set()))).toBe(false)
    // `- item`, caret ON the marker → raw.
    expect(hasBullet(buildDecorations(stateAt('- item', 1), [{ from: 0, to: 6 }], new Set()))).toBe(false)
    // `- item`, caret in the content (off the marker) → bullet rendered.
    expect(hasBullet(buildDecorations(stateAt('- item', 4), [{ from: 0, to: 6 }], new Set()))).toBe(true)
    // A non-empty SELECTION spanning the marker does NOT reveal (Obsidian):
    // Select-All keeps the bullet rendered so only the text highlights.
    expect(hasBullet(buildDecorations(stateSel('- item', 0, 6), [{ from: 0, to: 6 }], new Set()))).toBe(true)
  })

  it('checkbox reveal region is the `- [ ]` prefix, not the whole task item', () => {
    const doc = '- [ ] buy milk'
    const range = [{ from: 0, to: doc.length }]
    const checkbox = (d: ReturnType<typeof buildDecorations>) =>
      d.decos.some((r) => r.value.spec.widget instanceof CheckboxWidget)

    // Caret in the task TEXT (off the prefix) → checkbox stays rendered.
    expect(checkbox(buildDecorations(stateAt(doc, 9), range, new Set()))).toBe(true)
    // Caret ON the marker `[ ]` → raw, no checkbox.
    expect(checkbox(buildDecorations(stateAt(doc, 3), range, new Set()))).toBe(false)
  })

  it('bullet lines get a structural hanging-indent decoration (fixed em gutter)', () => {
    // Collect the styles of every cm-list-line line decoration.
    const listLineStyles = (d: ReturnType<typeof buildDecorations>) =>
      d.decos
        .filter((r) => (r.value.spec.class as string | undefined)?.includes('cm-list-line'))
        .map((r) => r.value.spec.attributes?.style as string)

    // Top-level bullet, caret off the marker → level-0 fixed gutter.
    expect(listLineStyles(buildDecorations(stateAt('- item', 4), [{ from: 0, to: 6 }], new Set()))).toContain(
      '--cm-list-pad:1.6em;--cm-list-marker-left:0em',
    )
    // Nested bullet (`  - b` under `- a`) → level 1: pad += one STEP.
    const nested = '- a\n  - b'
    expect(
      listLineStyles(buildDecorations(stateAt(nested, 8), [{ from: 0, to: nested.length }], new Set())),
    ).toContain('--cm-list-pad:3.2em;--cm-list-marker-left:1.6em')
    // Caret ON the marker → raw source, NO structural line decoration.
    expect(listLineStyles(buildDecorations(stateAt('- item', 1), [{ from: 0, to: 6 }], new Set()))).toHaveLength(
      0,
    )
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

// A non-empty selection (anchor ≠ head) — for testing that span selections
// don't trigger the caret-only reveal.
function stateSel(doc: string, anchor: number, head: number): EditorState {
  const state = EditorState.create({
    doc,
    selection: { anchor, head },
    extensions: [markdown({ extensions: [GFM] })],
  })
  ensureSyntaxTree(state, doc.length, 5000)
  return state
}
