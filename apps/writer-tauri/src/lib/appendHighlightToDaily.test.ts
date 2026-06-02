import { describe, expect, it } from 'vitest'
import { insertHighlightUnderSource } from './appendHighlightToDaily'

const TITLE = 'A Recipe for Training Neural Networks'

describe('insertHighlightUnderSource', () => {
  it('nests a child bullet under an existing breadcrumb', () => {
    const md = `- [[${TITLE}]]`
    expect(insertHighlightUnderSource(md, TITLE, 'overfit a single batch')).toBe(
      `- [[${TITLE}]]\n  - "overfit a single batch"`,
    )
  })

  it('appends multiple highlights under the same parent in order', () => {
    let md = `- [[${TITLE}]]\n  - "first"`
    md = insertHighlightUnderSource(md, TITLE, 'second')
    expect(md).toBe(`- [[${TITLE}]]\n  - "first"\n  - "second"`)
  })

  it('keeps the child block contiguous when other content follows', () => {
    const md = `- [[${TITLE}]]\n  - "first"\n\n- [[Other Article]]`
    expect(insertHighlightUnderSource(md, TITLE, 'second')).toBe(
      `- [[${TITLE}]]\n  - "first"\n  - "second"\n\n- [[Other Article]]`,
    )
  })

  it('creates a fresh breadcrumb when none exists', () => {
    const md = `Some earlier note for today.`
    expect(insertHighlightUnderSource(md, TITLE, 'a quote')).toBe(
      `Some earlier note for today.\n\n- [[${TITLE}]]\n  - "a quote"`,
    )
  })

  it('handles an empty daily', () => {
    expect(insertHighlightUnderSource('', TITLE, 'a quote')).toBe(
      `- [[${TITLE}]]\n  - "a quote"`,
    )
  })

  it('includes the note after an em dash', () => {
    const md = `- [[${TITLE}]]`
    expect(
      insertHighlightUnderSource(md, TITLE, 'a quote', 'my thought'),
    ).toBe(`- [[${TITLE}]]\n  - "a quote" — my thought`)
  })

  it('dedups an identical child line', () => {
    const md = `- [[${TITLE}]]\n  - "a quote"`
    expect(insertHighlightUnderSource(md, TITLE, 'a quote')).toBe(md)
  })

  it('collapses whitespace and caps very long quotes', () => {
    const long = 'x'.repeat(250)
    const out = insertHighlightUnderSource(`- [[${TITLE}]]`, TITLE, `  ${long}  `)
    expect(out).toBe(`- [[${TITLE}]]\n  - "${'x'.repeat(200)}…"`)
  })
})
