import { describe, expect, it } from 'vitest'
import { htmlToMarkdown, isRichHtml } from './htmlToMarkdown'

// Golden corpus: representative clipboard HTML fragments → markdown.
// Pins our conventions (`-` bullets, ATX headings, GFM tables) and the
// junk-stripping so structure survives a web paste.
describe('htmlToMarkdown', () => {
  it('converts headings to ATX', () => {
    expect(htmlToMarkdown('<h2>Title</h2>')).toBe('## Title')
  })

  it('uses "-" bullets, not "*"', () => {
    const md = htmlToMarkdown('<ul><li>one</li><li>two</li></ul>')
    expect(md).toBe('- one\n- two')
  })

  it('preserves nested list structure', () => {
    const md = htmlToMarkdown(
      '<ul><li>a<ul><li>a1</li></ul></li><li>b</li></ul>',
    )
    // single-space marker, 2-space nesting (our vault style)
    expect(md).toBe('- a\n  - a1\n- b')
  })

  it('numbers ordered lists with single-space markers', () => {
    const md = htmlToMarkdown('<ol><li>first</li><li>second</li></ol>')
    expect(md).toBe('1. first\n2. second')
  })

  it('strips whitespace-only spacer lines (no "  " gap lines)', () => {
    // Substack/Word wrap each <li>'s content in a <p>; Turndown emits
    // whitespace-only spacer lines between items. Those must be blanked
    // (a single paragraph break is fine; a "  " line is noise).
    const md = htmlToMarkdown(
      '<ol><li><p>first</p></li><li><p>second</p></li></ol>',
    )
    expect(md).toBe('1. first\n\n2. second')
    expect(md).not.toMatch(/\n[ \t]+\n/) // no whitespace-only lines
  })

  it('keeps links and bold', () => {
    const md = htmlToMarkdown(
      '<p>see <a href="https://x.com">x</a> and <strong>bold</strong></p>',
    )
    expect(md).toContain('[x](https://x.com)')
    expect(md).toContain('**bold**')
  })

  it('converts GFM tables', () => {
    const md = htmlToMarkdown(
      '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>',
    )
    expect(md).toContain('| a | b |')
    expect(md).toContain('| 1 | 2 |')
  })

  it('keeps images as markdown (src untouched)', () => {
    const md = htmlToMarkdown('<p><img src="https://x.com/a.png" alt="cap"></p>')
    expect(md).toBe('![cap](https://x.com/a.png)')
  })

  it('strips scripts/styles and comments', () => {
    const md = htmlToMarkdown(
      '<style>.x{}</style><!-- c --><p>hello</p><script>evil()</script>',
    )
    expect(md).toBe('hello')
  })

  it('drops manual-spacing empty paragraphs (no blank-line pile-up)', () => {
    const md = htmlToMarkdown('<p>one</p><p><br></p><p><br></p><p>two</p>')
    expect(md).toBe('one\n\ntwo')
  })

  it('drops &nbsp; spacer paragraphs', () => {
    const md = htmlToMarkdown('<p>a</p><p>&nbsp;</p><p>b</p>')
    expect(md).toBe('a\n\nb')
  })

  it('unwraps image-only links (no orphaned [] brackets)', () => {
    const md = htmlToMarkdown(
      '<a href="https://sub.com/link"><img src="https://cdn.com/x.png" alt="cap"></a>',
    )
    expect(md).toBe('![cap](https://cdn.com/x.png)')
  })

  it('unwraps NESTED image links (real Substack figure/div wrapper)', () => {
    // Substack wraps the <img> in a block element inside the link, and
    // links to a different-resolution URL — the exact shape that leaves
    // `[ … ](url)` around images on paste.
    const md = htmlToMarkdown(
      '<a href="https://cdn.com/full.png"><div><img src="https://cdn.com/resized.png"></div></a>',
    )
    expect(md).toBe('![](https://cdn.com/resized.png)')
  })

  it('unwraps picture-wrapped image links', () => {
    const md = htmlToMarkdown(
      '<a href="https://cdn.com/full.png"><picture><source srcset="x"><img src="https://cdn.com/r.png"></picture></a>',
    )
    expect(md).toBe('![](https://cdn.com/r.png)')
  })

  it('keeps links that wrap real text', () => {
    const md = htmlToMarkdown('<a href="https://x.com">click</a>')
    expect(md).toBe('[click](https://x.com)')
  })

  it('recovers Google-Docs style-based bold', () => {
    const md = htmlToMarkdown(
      '<p><span style="font-weight:700">bold</span> normal</p>',
    )
    expect(md).toBe('**bold** normal')
  })

  it('recovers style-based italic', () => {
    const md = htmlToMarkdown('<p><span style="font-style:italic">ital</span></p>')
    expect(md).toBe('*ital*')
  })

  it('drops display:none content instead of leaking it', () => {
    const md = htmlToMarkdown('<p>visible</p><p style="display:none">HIDDEN</p>')
    expect(md).toBe('visible')
  })

  it('keeps an image-only block that has no text', () => {
    const md = htmlToMarkdown('<div><img src="https://x.com/a.png" alt="c"></div>')
    expect(md).toBe('![c](https://x.com/a.png)')
  })
})

describe('isRichHtml', () => {
  it('is true for structural/formatted html', () => {
    expect(isRichHtml('<ul><li>x</li></ul>')).toBe(true)
    expect(isRichHtml('<p><a href="#">l</a></p>')).toBe(true)
  })

  it('is false for a plain-text span wrapper', () => {
    expect(isRichHtml('<meta charset="utf-8"><span>just text</span>')).toBe(false)
  })
})
