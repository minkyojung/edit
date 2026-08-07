// Pins the ONE thing that lets prose spacing distinguish a new paragraph from a
// plain Enter: the `cm-para-start` line decoration.
//
// CM already separates a SOFT WRAP from a hard break for free — a wrapped row stays
// inside the same `.cm-line`, so any per-line padding only lands on real (Enter)
// lines. What it can't tell apart on its own is:
//   • a line that just follows another line   (same paragraph)
//   • a line that follows a BLANK line        (new paragraph)
// Both were one `.cm-line`, so both got one gap token. This class is what splits them.
//
// The second half of the file guards something CSS can't assert at runtime: the
// theme's SOURCE ORDER. Every gap rule here has the same specificity (0,1,0), so
// "later wins" is the entire mechanism — `.cm-para-start` must sit AFTER `.cm-line`
// (to override the default gap) but BEFORE `.cm-list-line` and the headings (so a
// list item / heading following a blank line keeps its own spacing). Reorder them
// and nothing throws; the spacing just silently goes wrong for those lines.

import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { _buildDecos } from './livePreview'
import { cmThemeSpec } from '@/editor/theme/cmTheme'

/** Line numbers (1-based) carrying `cm-para-start`. */
function paraStartLines(doc: string): number[] {
  const state = EditorState.create({
    doc,
    // Caret at 0 — reveal state is irrelevant to a line class, but pin it so the
    // active-line reveal can't drift these expectations later.
    selection: { anchor: 0 },
    extensions: [markdown({ extensions: [GFM] })],
  })
  return _buildDecos(state, [{ from: 0, to: state.doc.length }])
    .filter((r) => (r.value.spec as { class?: string }).class?.split(' ').includes('cm-para-start'))
    .map((r) => state.doc.lineAt(r.from).number)
    .sort((a, b) => a - b)
}

describe('cm-para-start — "this line begins a new paragraph"', () => {
  it('a line after a BLANK line gets it', () => {
    //  1: 첫 문단
    //  2: (blank)
    //  3: 둘째 문단   ← new paragraph
    expect(paraStartLines('첫 문단\n\n둘째 문단')).toContain(3)
  })

  it('a line after a NON-blank line does NOT get it (Enter inside one paragraph)', () => {
    // Line 2 follows text directly — same paragraph, so it keeps the plain line gap.
    expect(paraStartLines('한 줄\n두 줄')).not.toContain(2)
  })

  it('the blank line ITSELF does not get it', () => {
    // The blank line is its own `.cm-line`; giving it the paragraph gap would double
    // the space (blank line box + gap + gap on the line below).
    expect(paraStartLines('첫 문단\n\n둘째 문단')).not.toContain(2)
  })

  it('the first line of the document gets it', () => {
    // Nothing above it — it is a paragraph start by definition. The theme's
    // `.cm-content > .cm-line:first-child` rule (higher specificity) zeroes the gap
    // there anyway, so this is about the class being consistent, not about pixels.
    expect(paraStartLines('첫 문단\n\n둘째 문단')).toContain(1)
  })

  it('several blank lines in a row only mark the line that actually has text', () => {
    //  1: a / 2: blank / 3: blank / 4: b
    expect(paraStartLines('a\n\n\nb')).toEqual([1, 4])
  })

  it('a list item after a blank line gets it TOO (the theme decides who wins)', () => {
    // The class is emitted purely from "previous line is blank" — it does not try to
    // know about lists. Which gap actually applies is settled by theme source order,
    // asserted below. Encoding the exception here instead would put the rule in two
    // places and let them drift.
    expect(paraStartLines('문단\n\n- 항목')).toContain(3)
  })
})

describe('cmTheme source order — the whole override mechanism', () => {
  const keys = Object.keys(cmThemeSpec)
  const at = (sel: string) => {
    const i = keys.indexOf(sel)
    expect(i, `theme is missing the selector \`${sel}\``).toBeGreaterThanOrEqual(0)
    return i
  }

  it('.cm-para-start comes AFTER .cm-line (so it overrides the default gap)', () => {
    expect(at('.cm-para-start')).toBeGreaterThan(at('.cm-line'))
  })

  it('.cm-para-start comes BEFORE .cm-list-line (a list item keeps list spacing)', () => {
    expect(at('.cm-para-start')).toBeLessThan(at('.cm-list-line'))
  })

  it('.cm-para-start comes BEFORE the heading rule (a heading keeps heading spacing)', () => {
    expect(at('.cm-para-start')).toBeLessThan(at('.cm-h1, .cm-h2, .cm-h3, .cm-h4, .cm-h5, .cm-h6'))
  })
})
