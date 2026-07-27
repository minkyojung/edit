// The two list-rendering paths must agree.
//
// A list line is drawn either by the Lezer `ListMark` branch or by the immediate
// regex fallback that covers the keystroke before the parser confirms the item.
// The fallback is load-bearing — an ordered list only becomes one once it has
// content, so without it a just-typed `1. ` would render nothing — and it has been
// deleted once and reverted for exactly that reason. It stays.
//
// What must NOT differ is the output. The two paths built their styles and class
// names separately and had drifted: the fallback never emitted `cm-task-done`, so
// a freshly typed `- [x] done` showed a ticked box over unstruck text until the
// parse landed (B8), and it derived nesting depth from a hardcoded 2-space unit
// while Lezer counted ancestor lists (B7).
//
// HOW THE FALLBACK IS REACHED HERE. Not by timing: vitest parses synchronously, so
// the syntax tree is always complete and `ListMark` is always present — every
// document that looks like a list takes the Lezer branch, and `listLinesDone` then
// makes the fallback skip the line. (This is the same constraint that makes the
// fallback's latency behavior itself untestable headlessly; that part needs the
// real app.) Instead we build the state WITHOUT the markdown language, so
// `syntaxTree` is empty, the tree walk emits nothing, and the regex path renders
// every line. That isolates the fallback deterministically and lets its output be
// diffed against the tree path's for the same text.

import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { indentUnit } from '@codemirror/language'
import { markdown } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { _buildDecos } from './livePreview'

type Deco = { from: number; to: number; class?: string; style?: string }

function decosOf(doc: string, extra: unknown[]): Deco[] {
  const state = EditorState.create({
    doc,
    selection: { anchor: doc.length }, // caret parked at the end: nothing revealed
    extensions: extra as never[],
  })
  return _buildDecos(state, [{ from: 0, to: state.doc.length }]).map((r) => ({
    from: r.from,
    to: r.to,
    class: (r.value.spec.class ?? r.value.spec.attributes?.class) as string | undefined,
    style: r.value.spec.attributes?.style as string | undefined,
  }))
}

/** Rendered by the Lezer `ListMark` branch. */
const viaTree = (doc: string, extra: unknown[] = []) =>
  decosOf(doc, [markdown({ extensions: [GFM] }), ...extra])

/** Rendered by the immediate regex fallback, isolated by giving it no syntax tree. */
const viaFallback = (doc: string, extra: unknown[] = []) => decosOf(doc, extra)

const listBits = (ds: Deco[]) =>
  ds.filter((d) => d.class?.includes('cm-list-') || d.class?.includes('cm-task-'))

const padOf = (d: Deco) => Number(/padding-left:([\d.]+)em/.exec(d.style ?? '')![1])
const lineDecos = (ds: Deco[]) => ds.filter((d) => d.class === 'cm-list-line')

describe('the harness really does split the two paths', () => {
  it('both arms render a plain bullet', () => {
    expect(listBits(viaTree('- item')).length).toBeGreaterThan(0)
    expect(listBits(viaFallback('- item')).length).toBeGreaterThan(0)
  })

  // Without this, the parity suite is satisfiable by DELETING the Lezer branch:
  // `listLinesDone` would stay empty, the fallback would render those lines in BOTH
  // arms, and every "identical decorations" assertion would hold trivially.
  //
  // The discriminator has to be something only the ListMark branch can produce.
  // Depth is it: Lezer counts ancestor lists, the fallback divides the indent by the
  // indent unit. At an indent that is not a multiple of the unit the two disagree —
  // which is B7's documented residual, and doubles as proof the tree arm is really
  // running the tree branch.
  it('the tree arm is really the tree — it derives depth from ancestors', () => {
    const doc = '- a\n    - b' // 4-space indent, 2-space unit
    const treePads = lineDecos(viaTree(doc)).map(padOf)
    const fbPads = lineDecos(viaFallback(doc)).map(padOf)
    expect(treePads[1], 'ancestor count → one level in').toBeLessThan(fbPads[1])
  })

  it('the tree arm owns the lines it renders — the fallback does not double up', () => {
    // One line, one `cm-list-line`. If the ListMark branch stopped populating
    // listLinesDone, the fallback would add a second.
    expect(lineDecos(viaTree('- item'))).toHaveLength(1)
  })
})

describe('B8 — a checked task strikes its body on BOTH paths', () => {
  it('the Lezer path emits cm-task-done after the marker gap', () => {
    const done = viaTree('- [x] done').find((d) => d.class === 'cm-task-done')
    expect(done).toBeDefined()
    expect(done!.from).toBe(6) // after `- [x] `
    expect(done!.to).toBe(10)
  })

  it('the fallback emits the identical cm-task-done range', () => {
    const treeDone = viaTree('- [x] done').find((d) => d.class === 'cm-task-done')
    const fbDone = viaFallback('- [x] done').find((d) => d.class === 'cm-task-done')
    expect(fbDone).toBeDefined()
    expect(fbDone).toEqual(treeDone)
  })

  it('neither path strikes an unchecked task', () => {
    expect(viaTree('- [ ] todo').find((d) => d.class === 'cm-task-done')).toBeUndefined()
    expect(viaFallback('- [ ] todo').find((d) => d.class === 'cm-task-done')).toBeUndefined()
  })
})

describe('B7 — nesting depth follows the configured indent unit', () => {
  it('a nested item indents one level deeper than its parent, on both paths', () => {
    for (const render of [viaTree, viaFallback]) {
      const lines = lineDecos(render('- parent\n  - child'))
      expect(lines).toHaveLength(2)
      expect(padOf(lines[1])).toBeGreaterThan(padOf(lines[0]))
    }
  })

  it('the fallback reads the indent unit rather than assuming 2 spaces', () => {
    // With a 4-space unit a 4-space indent is ONE level, not two.
    const doc = '- parent\n    - child'
    const at4 = lineDecos(viaFallback(doc, [indentUnit.of('    ')]))
    const at2 = lineDecos(viaFallback(doc, [indentUnit.of('  ')]))
    expect(padOf(at4[1])).toBeLessThan(padOf(at2[1]))
  })

  it('at the app\'s 2-space unit the fallback agrees with the tree', () => {
    const doc = '- parent\n  - child'
    const t = lineDecos(viaTree(doc, [indentUnit.of('  ')])).map(padOf)
    const f = lineDecos(viaFallback(doc, [indentUnit.of('  ')])).map(padOf)
    expect(f).toEqual(t)
  })
})

describe('parity — the same line renders the same way on either path', () => {
  for (const doc of ['- item', '1. item', '- [x] done', '- [ ] todo', '- parent\n  - child']) {
    it(`identical decorations for ${JSON.stringify(doc)}`, () => {
      expect(listBits(viaFallback(doc))).toEqual(listBits(viaTree(doc)))
    })
  }
})
