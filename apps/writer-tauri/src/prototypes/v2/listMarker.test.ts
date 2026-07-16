// After unifying list-marker rendering onto the single Lezer `ListMark` branch
// (the regex fallback was deleted; `buildDecos` forces the viewport parse via
// ensureSyntaxTree so the tree is authoritative), pin that every list shape still
// produces exactly the right marker decoration — and that there's no DOUBLE
// decoration (the two-path drift the fallback risked).

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

describe('list markers — single source (post-fallback-removal)', () => {
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
    // Top-level: one column (1.8em). Nested (under a parent item): two columns (3.6em).
    expect(style('- top')).toContain('padding-left:1.8em')
    expect(style('- parent\n  - child')).toBeTruthy() // parses as a nested list
  })
})
