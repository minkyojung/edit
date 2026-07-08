import { describe, expect, it } from 'vitest'
import { composeFrontmatter, splitFrontmatter } from './frontmatter'

describe('composeFrontmatter', () => {
  it('emits a block followed by the body', () => {
    expect(composeFrontmatter({ slug: 'abc123' }, 'Hello world')).toBe(
      '---\nslug: abc123\n---\n\nHello world\n',
    )
  })

  it('drops undefined, null, and empty-string fields', () => {
    expect(
      composeFrontmatter(
        { slug: 'abc', title: undefined, author: null, note: '' },
        'body',
      ),
    ).toBe('---\nslug: abc\n---\n\nbody\n')
  })

  it('returns the body alone when no field survives', () => {
    expect(composeFrontmatter({ title: undefined }, 'just body')).toBe('just body\n')
  })

  it('serialises numbers and booleans as bare scalars', () => {
    expect(composeFrontmatter({ archivedAt: 1718000000000, read: true }, 'b')).toBe(
      '---\narchivedAt: 1718000000000\nread: true\n---\n\nb\n',
    )
  })

  it('quotes values containing a colon or hash', () => {
    expect(composeFrontmatter({ title: 'A: a #1' }, 'b')).toBe(
      "---\ntitle: 'A: a #1'\n---\n\nb\n",
    )
  })

  it('doubles single quotes inside a quoted value', () => {
    // leading apostrophe forces quoting; inner quotes are doubled
    expect(composeFrontmatter({ title: "'tis" }, 'b')).toBe(
      "---\ntitle: '''tis'\n---\n\nb\n",
    )
  })

  it('does not add a second trailing newline when the body has one', () => {
    expect(composeFrontmatter({ slug: 'x' }, 'body\n')).toBe('---\nslug: x\n---\n\nbody\n')
  })
})

describe('splitFrontmatter', () => {
  it('parses fields and returns the body below', () => {
    const { data, body } = splitFrontmatter('---\nslug: abc\ntitle: Hi\n---\n\nHello')
    expect(data).toEqual({ slug: 'abc', title: 'Hi' })
    expect(body).toBe('Hello')
  })

  it('returns the whole input as body when there is no frontmatter', () => {
    const raw = '# Just a note\n\nNo frontmatter here.'
    expect(splitFrontmatter(raw)).toEqual({ data: {}, body: raw })
  })

  it('unquotes and unescapes values', () => {
    const { data } = splitFrontmatter("---\ntitle: 'A: a #1'\nq: '''tis'\n---\n\nb")
    expect(data).toEqual({ title: 'A: a #1', q: "'tis" })
  })

  it('skips comment and unparseable lines instead of throwing', () => {
    const { data, body } = splitFrontmatter('---\n# a comment\nslug: ok\nno-colon-line\n---\n\nb')
    expect(data).toEqual({ slug: 'ok' })
    expect(body).toBe('b')
  })

  it('treats a malformed (unclosed) block as no frontmatter', () => {
    const raw = '---\nslug: abc\n\nbody with no closing fence'
    expect(splitFrontmatter(raw)).toEqual({ data: {}, body: raw })
  })

  it('tolerates CRLF line endings', () => {
    const { data, body } = splitFrontmatter('---\r\nslug: abc\r\n---\r\n\r\nHello')
    expect(data).toEqual({ slug: 'abc' })
    expect(body).toBe('Hello')
  })

  it('does not mistake a body thematic break for a closing fence', () => {
    const { data, body } = splitFrontmatter('---\nslug: abc\n---\n\nintro\n\n---\n\nmore')
    expect(data).toEqual({ slug: 'abc' })
    expect(body).toBe('intro\n\n---\n\nmore')
  })
})

describe('round-trip', () => {
  it('compose → split preserves fields and body', () => {
    const fields = { slug: 'abc', title: 'A: tricky #title', archivedAt: 1718000000000 }
    const composed = composeFrontmatter(fields, 'The body.\nSecond line.')
    const { data, body } = splitFrontmatter(composed)
    expect(data).toEqual({ slug: 'abc', title: 'A: tricky #title', archivedAt: '1718000000000' })
    // compose guarantees the file ends in a newline; split reads it back faithfully
    expect(body).toBe('The body.\nSecond line.\n')
  })
})
