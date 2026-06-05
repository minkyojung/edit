// Headless proof for the slash menu's CompletionSource (research #2 §6):
// triggers only at line-start, never mid-line or in a code block, filters by
// keyword, and apply replaces the `/query` with the right marker. The popup /
// keyboard / focus are CM autocomplete's job (not re-tested here).

import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { CompletionContext } from '@codemirror/autocomplete'
import { ensureSyntaxTree } from '@codemirror/language'
import { markdown } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { slashSource, SLASH_ITEMS } from './slashCommands'

function ctxAt(doc: string, pos: number, explicit = false): CompletionContext {
  const state = EditorState.create({
    doc,
    selection: { anchor: pos },
    extensions: [markdown({ extensions: [GFM] })],
  })
  ensureSyntaxTree(state, doc.length, 5000)
  return new CompletionContext(state, pos, explicit)
}

describe('slash source — trigger conditions', () => {
  it('fires at line start `/` → returns all items', () => {
    const r = slashSource(ctxAt('/', 1))
    expect(r).not.toBeNull()
    expect(r!.options.length).toBe(SLASH_ITEMS.length)
    expect(r!.from).toBe(0)
  })

  it('does NOT fire mid-line (slash after text)', () => {
    expect(slashSource(ctxAt('hello /x', 8))).toBeNull()
  })

  it('does NOT fire inside a fenced code block', () => {
    const doc = '```\n/h1\n```'
    const pos = doc.indexOf('/h1') + 3
    expect(slashSource(ctxAt(doc, pos))).toBeNull()
  })
})

describe('slash source — keyword filtering', () => {
  it('`/h1` → Heading 1', () => {
    const r = slashSource(ctxAt('/h1', 3))!
    expect(r.options.map((o) => o.label)).toContain('Heading 1')
  })

  it('`/todo` → To-do list (keyword, not label)', () => {
    const r = slashSource(ctxAt('/todo', 5))!
    expect(r.options.map((o) => o.label)).toEqual(['To-do list'])
  })

  it('no match → null (no popup)', () => {
    expect(slashSource(ctxAt('/zzzzz', 6))).toBeNull()
  })
})

describe('slash source — apply replaces /query with the marker', () => {
  function applyFirst(doc: string, pos: number): string {
    const r = slashSource(ctxAt(doc, pos))!
    const opt = r.options[0]
    const view = new EditorView({
      state: EditorState.create({ doc, selection: { anchor: pos } }),
    })
    const apply = opt.apply as (v: EditorView, c: unknown, f: number, t: number) => void
    apply(view, opt, r.from, r.to ?? r.from)
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
