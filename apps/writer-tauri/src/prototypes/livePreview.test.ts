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

  // Lists use MARK-LEVEL reveal: a collapsed caret ON the marker token (bullet/
  // number) or the `- [ ]` prefix (task) shows raw; editing the item CONTENT
  // keeps the marker rendered; a span selection does NOT reveal. (The marker is
  // an in-flow widget, which is what keeps IME composition safe.)
  it('bullet: raw when caret on the marker, rendered when editing content', () => {
    const hasBullet = (d: ReturnType<typeof buildDecorations>) =>
      d.decos.some((r) => (r.value.spec.class as string | undefined)?.includes('cm-list-bullet'))

    // caret ON the dash → raw (no bullet)
    expect(hasBullet(buildDecorations(stateAt('- item', 1), [{ from: 0, to: 6 }], new Set()))).toBe(false)
    // caret in the content (off the marker) → bullet rendered
    expect(hasBullet(buildDecorations(stateAt('- item', 4), [{ from: 0, to: 6 }], new Set()))).toBe(true)
    // span selection does NOT reveal → bullet stays rendered
    expect(hasBullet(buildDecorations(stateSel('- item', 0, 6), [{ from: 0, to: 6 }], new Set()))).toBe(true)
  })

  it('task: checkbox raw on the `- [ ]` prefix, rendered when editing content', () => {
    const doc = '- [ ] buy milk'
    const range = [{ from: 0, to: doc.length }]
    const checkbox = (d: ReturnType<typeof buildDecorations>) =>
      d.decos.some((r) => (r.value.spec.class as string | undefined)?.includes('cm-list-checkbox'))

    // caret in the content (off the prefix) → checkbox rendered
    expect(checkbox(buildDecorations(stateAt(doc, 9), range, new Set()))).toBe(true)
    // caret ON the marker `[ ]` → raw
    expect(checkbox(buildDecorations(stateAt(doc, 3), range, new Set()))).toBe(false)
    // span selection → rendered (not revealed)
    expect(checkbox(buildDecorations(stateSel(doc, 0, doc.length), range, new Set()))).toBe(true)
  })

  it('ordered: number styled via mark in content, raw on the marker', () => {
    const doc = '1. first'
    const range = [{ from: 0, to: doc.length }]
    const numMark = (d: ReturnType<typeof buildDecorations>) =>
      d.decos.some((r) => r.value.spec.class === 'cm-list-num')

    // caret in the content → number mark applied (number stays as visible text)
    expect(numMark(buildDecorations(stateAt(doc, 5), range, new Set()))).toBe(true)
    // caret on the number → raw, no mark
    expect(numMark(buildDecorations(stateAt(doc, 1), range, new Set()))).toBe(false)
  })

  it('completed tasks get a strikethrough mark; open tasks do not', () => {
    const strike = (d: ReturnType<typeof buildDecorations>) =>
      d.decos.some((r) => r.value.spec.class === 'cm-task-checked')

    expect(strike(buildDecorations(stateAt('- [x] done', 8), [{ from: 0, to: 10 }], new Set()))).toBe(true)
    expect(strike(buildDecorations(stateAt('- [ ] todo', 8), [{ from: 0, to: 10 }], new Set()))).toBe(false)
  })

  it('bullet lines get a structural hanging-indent decoration (fixed em gutter)', () => {
    const listLineStyles = (d: ReturnType<typeof buildDecorations>) =>
      d.decos
        .filter((r) => (r.value.spec.class as string | undefined)?.includes('cm-list-line'))
        .map((r) => r.value.spec.attributes?.style as string)

    // Top-level bullet, caret in content → content column = indent(0.5) +
    // gutter(1.5) = 2em; the first row hangs one gutter left via CSS text-indent.
    const top = listLineStyles(buildDecorations(stateAt('- item', 4), [{ from: 0, to: 6 }], new Set()))
    expect(top.some((s) => s.includes('--cm-list-pad:2em'))).toBe(true)
    // Nested (`  - b` under `- a`), caret in the nested content → level 1 column
    // offset by one STEP: 1.6 + 0.5 + 1.5 = 3.6em.
    const nested = '- a\n  - b'
    const deep = listLineStyles(buildDecorations(stateAt(nested, 8), [{ from: 0, to: nested.length }], new Set()))
    expect(deep.some((s) => s.includes('--cm-list-pad:3.6em'))).toBe(true)
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
