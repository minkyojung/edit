import { describe, expect, it } from 'vitest'
import {
  composeFrontmatter,
  mergeFrontmatter,
  splitFrontmatter,
} from './frontmatter'

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

describe('mergeFrontmatter', () => {
  it('is byte-identical to composeFrontmatter for an app-only file', () => {
    // The flush guard (fileContentEquals) relies on this: rewriting a doc
    // whose frontmatter the app fully owns must not change a single byte,
    // or every doc surfaces as a phantom change.
    const existing = composeFrontmatter({ slug: 'abc123' }, 'old body')
    expect(mergeFrontmatter(existing, { slug: 'abc123' }, 'new body')).toBe(
      composeFrontmatter({ slug: 'abc123' }, 'new body'),
    )
  })

  it('preserves a YAML list the flat parser cannot represent', () => {
    const existing =
      '---\ntags:\n  - project\n  - draft\nslug: old\n---\n\nObsidian note'
    const out = mergeFrontmatter(existing, { slug: 'new' }, 'edited body')
    // The list survives verbatim; the app key is replaced, not duplicated.
    expect(out).toBe(
      '---\ntags:\n  - project\n  - draft\nslug: new\n---\n\nedited body\n',
    )
  })

  it('preserves nested maps, aliases, and comments verbatim', () => {
    const existing = [
      '---',
      '# user metadata',
      'aliases: [foo, bar]',
      'cssclasses:',
      '  - wide',
      'slug: keepme',
      '---',
      '',
      'body',
    ].join('\n')
    const out = mergeFrontmatter(existing, { slug: 'keepme' }, 'body')
    expect(out).toBe(
      [
        '---',
        '# user metadata',
        'aliases: [foo, bar]',
        'cssclasses:',
        '  - wide',
        'slug: keepme',
        '---',
        '',
        'body\n',
      ].join('\n'),
    )
  })

  it('appends app fields when the file had no frontmatter', () => {
    expect(mergeFrontmatter('just a body', { slug: 'x' }, 'just a body')).toBe(
      '---\nslug: x\n---\n\njust a body\n',
    )
  })

  it('drops an app key whose new value is empty (removal)', () => {
    const existing = '---\ntitle: Keep\narchivedAt: 123\n---\n\nb'
    // archivedAt owned by app + now empty → removed; user title preserved.
    expect(mergeFrontmatter(existing, { archivedAt: undefined }, 'b')).toBe(
      '---\ntitle: Keep\n---\n\nb\n',
    )
  })

  it('does not treat a colon inside a value as a new key boundary', () => {
    const existing = "---\ntitle: 'A: a #1'\nslug: s\n---\n\nb"
    expect(mergeFrontmatter(existing, { slug: 's' }, 'b')).toBe(
      "---\ntitle: 'A: a #1'\nslug: s\n---\n\nb\n",
    )
  })
})
