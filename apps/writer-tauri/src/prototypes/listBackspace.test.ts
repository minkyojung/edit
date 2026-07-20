// Backspace right after a TOP-LEVEL list marker removes it cleanly (no "  ").
// Critical safety cases: nested markers, mid-content, and code blocks must FALL
// THROUGH (return false) so CM's deleteMarkupBackward keeps its behavior.
import { describe, it, expect } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { forceParsing } from '@codemirror/language'
import { markdown } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { clearTopLevelMarkerBackward, dedentContinuationBackward } from './listBackspace'

function mk(doc: string, caret: number) {
  const v = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc,
      selection: { anchor: caret },
      extensions: [markdown({ extensions: [GFM], addKeymap: false })],
    }),
  })
  forceParsing(v, v.state.doc.length, 1e9)
  return v
}

describe('clearTopLevelMarkerBackward — clean delete, no ghost spaces', () => {
  it('bullet: "- 사과" caret after marker → "사과" at col 0', () => {
    const v = mk('- 사과', 2)
    expect(clearTopLevelMarkerBackward(v)).toBe(true)
    expect(v.state.doc.toString()).toBe('사과')
    expect(v.state.selection.main.head).toBe(0)
    v.destroy()
  })

  it('empty bullet: "- " → "" (no leftover spaces)', () => {
    const v = mk('- ', 2)
    expect(clearTopLevelMarkerBackward(v)).toBe(true)
    expect(v.state.doc.toString()).toBe('')
    v.destroy()
  })

  it('ordered: "1. item" caret after "1. " → "item"', () => {
    const v = mk('1. item', 3)
    expect(clearTopLevelMarkerBackward(v)).toBe(true)
    expect(v.state.doc.toString()).toBe('item')
    v.destroy()
  })

  it('star bullet: "* item" → "item"', () => {
    const v = mk('* item', 2)
    expect(clearTopLevelMarkerBackward(v)).toBe(true)
    expect(v.state.doc.toString()).toBe('item')
    v.destroy()
  })
})

describe('clearTopLevelMarkerBackward — must FALL THROUGH (return false)', () => {
  it('NESTED marker stays with CM (preserve indentation)', () => {
    const v = mk('- a\n  - b', 8) // caret after "  - " on line 2
    expect(clearTopLevelMarkerBackward(v)).toBe(false)
    expect(v.state.doc.toString()).toBe('- a\n  - b') // untouched
    v.destroy()
  })

  it('caret in the MIDDLE of content → false', () => {
    const v = mk('- 사과', 3)
    expect(clearTopLevelMarkerBackward(v)).toBe(false)
    v.destroy()
  })

  it('caret BEFORE the marker (col 0) → false', () => {
    const v = mk('- item', 0)
    expect(clearTopLevelMarkerBackward(v)).toBe(false)
    v.destroy()
  })

  it('plain text → false', () => {
    const v = mk('hello', 0)
    expect(clearTopLevelMarkerBackward(v)).toBe(false)
    v.destroy()
  })

  it('"- " literal INSIDE a code block → false (not a real marker)', () => {
    const v = mk('```\n- x\n```', 6) // caret after "- " on the fenced line
    expect(clearTopLevelMarkerBackward(v)).toBe(false)
    expect(v.state.doc.toString()).toBe('```\n- x\n```') // untouched
    v.destroy()
  })
})

describe('dedentContinuationBackward — one press clears an indented continuation', () => {
  it('empty indented continuation "- item\\n  " → "- item\\n"', () => {
    const v = mk('- item\n  ', 9) // caret at end (line.from 7 + ws 2)
    expect(dedentContinuationBackward(v)).toBe(true)
    expect(v.state.doc.toString()).toBe('- item\n')
    expect(v.state.selection.main.head).toBe(7)
    v.destroy()
  })

  it('indented continuation with content "- item\\n  cont" → dedents to margin', () => {
    const v = mk('- item\n  cont', 9) // caret at content start (after "  ")
    expect(dedentContinuationBackward(v)).toBe(true)
    expect(v.state.doc.toString()).toBe('- item\ncont')
    v.destroy()
  })

  it('ordered continuation "1. item\\n   cont" (3-space col) → "1. item\\ncont"', () => {
    const v = mk('1. item\n   cont', 11) // caret after 3 spaces
    expect(dedentContinuationBackward(v)).toBe(true)
    expect(v.state.doc.toString()).toBe('1. item\ncont')
    v.destroy()
  })

  it('caret MID-content → false (normal delete)', () => {
    const v = mk('- item\n  cont', 11) // inside "cont"
    expect(dedentContinuationBackward(v)).toBe(false)
    v.destroy()
  })

  it('nested MARKER line → false (deleteMarkupBackward handles it)', () => {
    const v = mk('- a\n  - b', 6) // caret at the nested "-"
    expect(dedentContinuationBackward(v)).toBe(false)
    v.destroy()
  })

  it('indented line inside a code fence → false (keep literal indent)', () => {
    const v = mk('```\n    code\n```', 8) // caret after 4 spaces in the fence
    expect(dedentContinuationBackward(v)).toBe(false)
    expect(v.state.doc.toString()).toBe('```\n    code\n```')
    v.destroy()
  })

  it('ordinary indented paragraph (not a list) with content → false', () => {
    const v = mk('  hello', 2) // 2-space indented paragraph, caret at content start
    expect(dedentContinuationBackward(v)).toBe(false)
    v.destroy()
  })
})
