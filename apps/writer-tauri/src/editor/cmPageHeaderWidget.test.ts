// Headless placement proof for the page-header block widget. We can't render the
// React PageHeader here (that needs a browser + stores), but the guarantee we care
// about lives in the decoration placement: exactly one BLOCK widget, pinned to
// document position 0, that STAYS at 0 across edits (so the title/frontmatter always
// sit at the very top of the scroller). toDOM() is never called, so importing the
// module stays light.

import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { Decoration, type DecorationSet } from '@codemirror/view'
import { pageHeaderWidget } from './cmPageHeaderWidget'

function blockWidgetPos(set: DecorationSet): { from: number; to: number; block: boolean } | null {
  let hit: { from: number; to: number; block: boolean } | null = null
  set.between(0, 1e9, (from, to, deco) => {
    if (deco instanceof Decoration && deco.spec.widget) {
      hit = { from, to, block: deco.spec.block === true }
      return false
    }
  })
  return hit
}

describe('page-header block widget — placement', () => {
  it('places exactly one block widget at document position 0', () => {
    const field = pageHeaderWidget('my-note')
    const state = EditorState.create({ doc: 'first line\n\nsecond', extensions: [field] })
    const hit = blockWidgetPos(state.field(field))
    expect(hit).not.toBeNull()
    expect(hit!.from).toBe(0)
    expect(hit!.to).toBe(0)
    expect(hit!.block).toBe(true)
  })

  it('stays pinned at position 0 after inserting text at the top', () => {
    const field = pageHeaderWidget('my-note')
    const state = EditorState.create({ doc: 'body', extensions: [field] })
    // Type a character at the very start of the doc.
    const next = state.update({ changes: { from: 0, insert: 'X' } }).state
    const hit = blockWidgetPos(next.field(field))
    expect(hit).not.toBeNull()
    // side -1 keeps the widget before all content, so it must remain at 0 (not
    // pushed to 1 by the insertion) — otherwise the header would drift below the
    // first typed character.
    expect(hit!.from).toBe(0)
    expect(hit!.block).toBe(true)
  })

  it('survives on an empty document', () => {
    const field = pageHeaderWidget('my-note')
    const state = EditorState.create({ doc: '', extensions: [field] })
    const hit = blockWidgetPos(state.field(field))
    expect(hit).not.toBeNull()
    expect(hit!.from).toBe(0)
  })
})
