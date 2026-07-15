import { describe, expect, it } from 'vitest'
import { markdownToHtml } from './markdownToHtml'

// The point of the rich-text copy path: markdown structure must become
// real HTML elements, so an external editor renders formatting instead
// of showing raw `##` / `-` source. These assertions lock the element
// shapes that matter for paste fidelity.
describe('markdownToHtml', () => {
  it('renders headings as <h*> not literal ##', () => {
    const html = markdownToHtml('## Section')
    expect(html).toContain('<h2>Section</h2>')
    expect(html).not.toContain('##')
  })

  it('renders "-" bullets as a real <ul><li> list', () => {
    const html = markdownToHtml('- one\n- two')
    expect(html).toContain('<ul>')
    expect(html).toContain('<li>one</li>')
    expect(html).toContain('<li>two</li>')
    // The "-" marker must not survive as text — that was the whole bug.
    expect(html).not.toMatch(/>-\s/)
  })

  it('renders bold and links', () => {
    const html = markdownToHtml('**bold** and [site](https://example.com)')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('>site</a>')
  })

  it('renders GFM tables (remark-gfm is wired in)', () => {
    const html = markdownToHtml('| a | b |\n| - | - |\n| 1 | 2 |')
    expect(html).toContain('<table>')
    expect(html).toContain('<td>1</td>')
  })

  it('keeps a fenced code block as <pre><code>', () => {
    const html = markdownToHtml('```\ncode\n```')
    expect(html).toContain('<pre>')
    expect(html).toContain('<code>')
    expect(html).toContain('code')
  })
})
