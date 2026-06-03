import { describe, expect, it } from 'vitest'
import { renderMarkdownToFragment } from './renderMarkdownInline'

/** Test helper — render to fragment then read the resulting HTML
 * via a host div. Concatenated HTML is easier to assert against
 * than walking the fragment manually. */
function renderHtml(md: string): string {
  const host = document.createElement('div')
  host.appendChild(renderMarkdownToFragment(md))
  return host.innerHTML
}

describe('renderMarkdownToFragment — block elements', () => {
  it('renders an empty string as an empty fragment', () => {
    expect(renderHtml('')).toBe('')
  })

  it('renders a single paragraph', () => {
    expect(renderHtml('Hello world')).toBe(
      '<p class="md-para">Hello world</p>',
    )
  })

  it('renders headings h1 through h6', () => {
    expect(renderHtml('# H1')).toBe('<h1>H1</h1>')
    expect(renderHtml('## H2')).toBe('<h2>H2</h2>')
    expect(renderHtml('### H3')).toBe('<h3>H3</h3>')
    expect(renderHtml('###### H6')).toBe('<h6>H6</h6>')
  })

  it('renders a bullet list', () => {
    expect(renderHtml('- first\n- second')).toBe(
      '<ul class="md-list"><li>first</li><li>second</li></ul>',
    )
  })

  it('accepts `*` / `+` as bullet markers', () => {
    expect(renderHtml('* one\n+ two')).toContain('<li>one</li>')
    expect(renderHtml('* one\n+ two')).toContain('<li>two</li>')
  })

  it('renders a blockquote', () => {
    expect(renderHtml('> quoted line')).toBe(
      '<blockquote class="md-quote">quoted line</blockquote>',
    )
  })

  it('separates blocks by blank line', () => {
    const html = renderHtml('# Title\n\nBody paragraph')
    expect(html).toContain('<h1>Title</h1>')
    expect(html).toContain('<p class="md-para">Body paragraph</p>')
  })
})

describe('renderMarkdownToFragment — inline elements', () => {
  it('renders [[wikilinks]] as anchors with md-wikilink class', () => {
    const html = renderHtml('See [[Sera]] for details.')
    expect(html).toContain('<a class="md-wikilink">Sera</a>')
  })

  it('renders [Title](note:slug) as wikilink-styled anchor', () => {
    const html = renderHtml('Linked to [Sera](note:uvxw2blh)')
    expect(html).toContain('<a class="md-wikilink">Sera</a>')
  })

  it('renders regular [text](url) as plain link', () => {
    const html = renderHtml('See [docs](https://example.com)')
    // jsdom may emit attributes in any order; assert on each piece
    // independently so the test isn't coupled to attribute ordering.
    expect(html).toContain('class="md-link"')
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('rel="noreferrer noopener"')
    expect(html).toContain('>docs</a>')
  })

  it('strips unsafe link schemes (javascript:) — renders inert, no href', () => {
    const html = renderHtml('Click [me](javascript:alert(1))')
    expect(html).toContain('class="md-link"')
    expect(html).toContain('>me</a>')
    // No live href / rel on a dangerous-scheme link.
    expect(html).not.toContain('href=')
    expect(html).not.toContain('javascript:')
  })

  it('strips data: scheme links', () => {
    const html = renderHtml('[x](data:text/html,<script>alert(1)</script>)')
    expect(html).not.toContain('href=')
  })

  it('keeps mailto: links', () => {
    const html = renderHtml('[mail](mailto:a@b.com)')
    expect(html).toContain('href="mailto:a@b.com"')
  })

  it('renders **bold** as <strong>', () => {
    const html = renderHtml('This is **important**.')
    expect(html).toContain('<strong>important</strong>')
  })

  it('handles escaped wikilinks (commonmark roundtrip artefact)', () => {
    // \[\[Sera]] and \[\[Sera\]\] should both render as the wikilink
    expect(renderHtml('Mention \\[\\[Sera]] today')).toContain(
      '<a class="md-wikilink">Sera</a>',
    )
    expect(renderHtml('Mention \\[\\[Sera\\]\\] today')).toContain(
      '<a class="md-wikilink">Sera</a>',
    )
  })

  it('preserves plain text around inline tokens', () => {
    const html = renderHtml('Hello **bold** world')
    expect(html).toContain('Hello ')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain(' world')
  })

  it('falls through gracefully on unclosed brackets', () => {
    // Half-open `[[` with no closing `]]` — should not crash, should
    // render the leading text and let the rest fall through.
    const html = renderHtml('See [[ for hints')
    expect(html).toContain('[[ for hints')
  })
})

describe('renderMarkdownToFragment — composite shapes', () => {
  it('renders a heading + bullet block (chat replace shape)', () => {
    const md = '# Daniel\n\n* Proposed marriage to [[Sera]]'
    const html = renderHtml(md)
    expect(html).toContain('<h1>Daniel</h1>')
    expect(html).toContain('<ul class="md-list">')
    expect(html).toContain('<a class="md-wikilink">Sera</a>')
  })

  it('renders multi-line blockquote', () => {
    const html = renderHtml('> first\n> second')
    expect(html).toContain('<blockquote')
    expect(html).toContain('first')
    expect(html).toContain('second')
  })

  it('renders multi-bullet list with mixed inline formatting', () => {
    const html = renderHtml(
      '- See [[Sera]]\n- See **bold** text\n- See [docs](https://x.com)',
    )
    expect(html).toContain('<a class="md-wikilink">Sera</a>')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('https://x.com')
  })
})
