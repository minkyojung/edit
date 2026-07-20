// Characterizes list-marker rendering: every list shape produces the right marker
// decoration, and there's no DOUBLE decoration (the tree path + the immediate-marker
// regex fallback are deduped by `listLinesDone`).
//
// NOTE: this can't catch the regression that matters most — an EMPTY just-typed
// marker (`- `, `1. `) rendering IMMEDIATELY. Headless states parse synchronously, so
// the tree already has the ListMark; the fallback's value (painting the marker before
// the incremental parser catches up, especially for ordered markers, which Lezer only
// confirms once the item has content) only shows in the live editor. Removing the
// fallback in favor of a forced parse (ensureSyntaxTree) passed these tests yet broke
// `1. ` in-app — see the revert. Real-app eyeball is the only guard for immediacy.

import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { _buildDecos } from './livePreview'

function decos(doc: string, caret = doc.length) {
  const state = EditorState.create({
    doc,
    selection: { anchor: caret },
    extensions: [markdown({ extensions: [GFM] })],
  })
  return _buildDecos(state, [{ from: 0, to: state.doc.length }])
}
// Classes on the marker mark at the given [from,to] (a marker is a `mark`, not a line deco).
function markerClassAt(doc: string, from: number, to: number, caret = doc.length): string | undefined {
  return decos(doc, caret)
    .filter((r) => r.from === from && r.to === to)
    .map((r) => (r.value.spec as { class?: string }).class)
    .find((c) => c?.includes('cm-list-marker'))
}
// Count of `cm-list-line` line decorations on the first line (must be exactly 1 — no
// double from a second code path).
function listLineCount(doc: string): number {
  return decos(doc).filter((r) => (r.value.spec as { class?: string }).class === 'cm-list-line').length
}

describe('list markers — tree path + immediate regex fallback', () => {
  it('bullet `- item` → cm-list-bullet', () => {
    expect(markerClassAt('- item', 0, 1)).toContain('cm-list-bullet')
  })

  it('empty bullet `- ` (the case the fallback existed for) → cm-list-bullet', () => {
    // caret at end (2) is OFF the marker [0,1], so it renders (not revealed as raw).
    expect(markerClassAt('- ', 0, 1)).toContain('cm-list-bullet')
  })

  it('ordered `1. item` → cm-list-num', () => {
    expect(markerClassAt('1. item', 0, 2)).toContain('cm-list-num')
  })

  it('task `- [ ] x` → cm-task-marker', () => {
    // caret at end (7) is OFF the marker [0,5], so the checkbox marker renders.
    expect(markerClassAt('- [ ] x', 0, 5)).toContain('cm-task-marker')
  })

  it('exactly ONE cm-list-line per list line (no double decoration)', () => {
    expect(listLineCount('- item')).toBe(1)
    expect(listLineCount('1. item')).toBe(1)
  })

  it('a dash inside a code fence is NOT a list marker', () => {
    const doc = '```\n- not a list\n```'
    const dashPos = doc.indexOf('- not')
    const hasMarker = decos(doc).some(
      (r) => r.from === dashPos && (r.value.spec as { class?: string }).class?.includes('cm-list-marker'),
    )
    expect(hasMarker).toBe(false)
  })

  it('nested bullet gets a deeper hanging-indent than a top-level one', () => {
    const style = (doc: string) =>
      decos(doc)
        .filter((r) => (r.value.spec as { class?: string }).class === 'cm-list-line')
        .map((r) => (r.value.spec as { attributes?: { style?: string } }).attributes?.style)[0] ?? ''
    // Column = LIST_INDENT (1.8) + LIST_MARKER_SPACE (0.25) = 2.05em per level; the
    // first line pulls the marker back by (LIST_INDENT + space) so its body and the
    // wrapped line share one x. Top-level: one column. text-indent matches padding.
    expect(style('- top')).toContain('padding-left:2.05em;text-indent:-2.05em')
    expect(style('- parent\n  - child')).toBeTruthy() // parses as a nested list
  })

  it('a flush-left lazy continuation (no marker, no indent) is NOT hung to the body column', () => {
    // `- a\nb` — `b` has no marker and no indent. CommonMark folds it into the item, but
    // the user typed it at the margin, so it renders flush-left (not yanked to the body
    // column). This is the fix for the "type below a list → paragraph jumps right" bug.
    const doc = '- a\nb'
    const line2From = doc.indexOf('\n') + 1
    const cont = decos(doc).find(
      (r) => r.from === line2From && (r.value.spec as { class?: string }).class === 'cm-list-line',
    )
    expect(cont).toBeUndefined()
  })

  it('a continuation INDENTED to the content column hangs at the body column, its leading spaces pulled back', () => {
    // `- a\n  b` — `b` is indented 2 cols (= the `- ` content column), so it is a real
    // list continuation and hangs at the body column (2.05em). Its 2 literal spaces are
    // pulled back by text-indent (2 × LIST_MARKER_SPACE 0.25 = 0.5em) so the first row
    // and any wrapped row both land at the body column — no double indent.
    const doc = '- a\n  b'
    const line2From = doc.indexOf('\n') + 1
    const cont = decos(doc).find(
      (r) => r.from === line2From && (r.value.spec as { class?: string }).class === 'cm-list-line',
    )
    const style = (cont?.value.spec as { attributes?: { style?: string } })?.attributes?.style ?? ''
    expect(style).toContain('padding-left:2.05em')
    expect(style).toContain('text-indent:-0.5em')
  })
})

// An empty marker placed below a DIFFERENT-type list is parsed by CommonMark as lazy
// continuation of the item above, so Lezer produces NO ListMark for it — only the
// regex fallback can render it immediately. The fallback's horizontal-rule guard used
// to skip a lone `- ` / `* ` (a single rule char reads like an HR-in-progress), so an
// empty bullet under a numbered list showed no marker until content was typed. A real
// HR needs 3+ rule chars, so the guard now requires that. (Unlike the "immediacy"
// regressions, THIS is headless-testable: the tree genuinely lacks the node even fully
// parsed, so the fallback's decision is what's under test.)
describe('empty bullet below a different-type list (HR-guard fix)', () => {
  const bulletAt = (doc: string, from: number, to: number) =>
    decos(doc).some(
      (r) => r.from === from && r.to === to && (r.value.spec as { class?: string }).class?.includes('cm-list-bullet'),
    )
  const anyBullet = (doc: string) =>
    decos(doc).some((r) => (r.value.spec as { class?: string }).class?.includes('cm-list-bullet'))

  it('renders `- ` under a numbered list (the reported bug)', () => {
    expect(bulletAt('1. a\n- ', 5, 6)).toBe(true)
  })
  it('does NOT render `---` (horizontal rule) as a bullet', () => {
    expect(anyBullet('--- ')).toBe(false)
  })
  it('does NOT render `- - -` (spaced rule) as a bullet', () => {
    expect(anyBullet('- - -')).toBe(false)
  })
})
