// Headless proof for the slash menu's logic: triggers only at line-start, never
// mid-line or in a code block, filters by keyword, and each item's `apply`
// replaces the `/query` with the right marker. The popup / keyboard / focus /
// positioning are covered by CM (StateField + showTooltip) and not re-tested.

import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { ensureSyntaxTree } from '@codemirror/language'
import { markdown } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { SLASH_ITEMS } from './slashCommands'
import { readSlash } from '@/editor/slashMenu'

function stateAt(doc: string, pos: number): EditorState {
  const state = EditorState.create({
    doc,
    selection: { anchor: pos },
    extensions: [markdown({ extensions: [GFM] })],
  })
  ensureSyntaxTree(state, doc.length, 5000)
  return state
}

describe('slash menu — trigger conditions', () => {
  it('fires at line start `/` → all items', () => {
    const s = readSlash(stateAt('/', 1), null)
    expect(s).not.toBeNull()
    expect(s!.items.length).toBe(SLASH_ITEMS.length)
    expect(s!.from).toBe(0)
  })

  it('does NOT fire mid-line (slash after text)', () => {
    expect(readSlash(stateAt('hello /x', 8), null)).toBeNull()
  })

  it('does NOT fire inside a fenced code block', () => {
    const doc = '```\n/h1\n```'
    const pos = doc.indexOf('/h1') + 3
    expect(readSlash(stateAt(doc, pos), null)).toBeNull()
  })
})

describe('slash menu — keyword filtering', () => {
  it('`/h1` → Heading 1', () => {
    const s = readSlash(stateAt('/h1', 3), null)!
    expect(s.items.map((i) => i.label)).toContain('Heading 1')
  })

  it('`/todo` → To-do list (keyword, not label)', () => {
    const s = readSlash(stateAt('/todo', 5), null)!
    expect(s.items.map((i) => i.label)).toEqual(['To-do list'])
  })

  it('no match → null (no popup)', () => {
    expect(readSlash(stateAt('/zzzzz', 6), null)).toBeNull()
  })

  it('keeps the selected index within the shrinking list', () => {
    const prev = { from: 0, to: 3, items: SLASH_ITEMS, selectedIndex: 9 }
    const s = readSlash(stateAt('/todo', 5), prev)!
    expect(s.items.length).toBe(1)
    expect(s.selectedIndex).toBe(0)
  })
})

describe('slash menu — apply replaces /query with the marker', () => {
  function applyFirst(doc: string, pos: number): string {
    const state = stateAt(doc, pos)
    const s = readSlash(state, null)!
    const view = new EditorView({ state })
    s.items[0].apply(view, s.from, s.to)
    const text = view.state.doc.toString()
    view.destroy()
    return text
  }

  it('`/h1` → "# "', () => {
    expect(applyFirst('/h1', 3)).toBe('# ')
  })

  it('`/todo` → "- [ ] "', () => {
    expect(applyFirst('/todo', 5)).toBe('- [ ] ')
  })
})
