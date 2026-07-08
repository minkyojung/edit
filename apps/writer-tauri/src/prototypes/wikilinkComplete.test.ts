// Headless proof for the wikilink CompletionSource (research #3): triggers on
// `[[` (including mid-text, unlike slash), lists/filters note titles, offers a
// create option, skips code blocks, and apply inserts `[[Title]]`.

import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { CompletionContext } from '@codemirror/autocomplete'
import { ensureSyntaxTree } from '@codemirror/language'
import { markdown } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { wikilinkSource } from './wikilinkComplete'

function ctxAt(doc: string, pos: number): CompletionContext {
  const state = EditorState.create({
    doc,
    selection: { anchor: pos },
    extensions: [markdown({ extensions: [GFM] })],
  })
  ensureSyntaxTree(state, doc.length, 5000)
  return new CompletionContext(state, pos, false)
}

describe('wikilink source — trigger', () => {
  it('fires on bare `[[` → all titles', () => {
    const r = wikilinkSource(ctxAt('[[', 2))
    expect(r).not.toBeNull()
    expect(r!.from).toBe(0)
    expect(r!.options.map((o) => o.label)).toContain('Project Brasilia')
  })

  it('fires MID-TEXT (unlike slash) → `see [[r`', () => {
    const r = wikilinkSource(ctxAt('see [[r', 7))
    expect(r).not.toBeNull()
    expect(r!.options.map((o) => o.label)).toContain('Roadmap')
  })

  it('does NOT fire inside a code block', () => {
    const doc = '```\n[[x\n```'
    const pos = doc.indexOf('[[x') + 3
    expect(wikilinkSource(ctxAt(doc, pos))).toBeNull()
  })
})

describe('wikilink source — filter + create', () => {
  it('`[[pro` → Project Brasilia (+ create option for the query)', () => {
    const labels = wikilinkSource(ctxAt('[[pro', 5))!.options.map((o) => o.label)
    expect(labels).toContain('Project Brasilia')
    expect(labels.some((l) => l.startsWith('Create'))).toBe(true)
  })

  it('exact title `[[Roadmap` → no create option', () => {
    const labels = wikilinkSource(ctxAt('[[Roadmap', 9))!.options.map((o) => o.label)
    expect(labels.some((l) => l.startsWith('Create'))).toBe(false)
  })
})

describe('wikilink source — apply inserts [[Title]]', () => {
  it('`[[pro` → pick Project Brasilia → `[[Project Brasilia]]`', () => {
    const r = wikilinkSource(ctxAt('[[pro', 5))!
    const opt = r.options.find((o) => o.label === 'Project Brasilia')!
    const view = new EditorView({
      state: EditorState.create({ doc: '[[pro', selection: { anchor: 5 } }),
    })
    const apply = opt.apply as (v: EditorView, c: unknown, f: number, t: number) => void
    apply(view, opt, r.from, r.to ?? r.from)
    const text = view.state.doc.toString()
    view.destroy()
    expect(text).toBe('[[Project Brasilia]]')
  })
})
