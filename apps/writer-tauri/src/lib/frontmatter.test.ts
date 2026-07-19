import { describe, expect, it } from 'vitest'
import {
  composeFrontmatter,
  mergeFrontmatter,
  parseFrontmatterBlock,
  parseFrontmatterFull,
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

describe('composeFrontmatter — list values', () => {
  it('emits a string array as a YAML block sequence', () => {
    expect(composeFrontmatter({ tags: ['ai', 'finance'] }, 'body')).toBe(
      '---\ntags:\n  - ai\n  - finance\n---\n\nbody\n',
    )
  })

  it('drops an empty array (like an empty scalar)', () => {
    expect(composeFrontmatter({ tags: [], slug: 'x' }, 'body')).toBe(
      '---\nslug: x\n---\n\nbody\n',
    )
  })

  it('quotes list items that need it', () => {
    expect(composeFrontmatter({ tags: ['a: b', 'plain'] }, 'body')).toBe(
      "---\ntags:\n  - 'a: b'\n  - plain\n---\n\nbody\n",
    )
  })

  it('is byte-identical to the old scalar emitter for scalar-only fields', () => {
    // Byte-stability guard: adding list support must not change scalar output.
    expect(composeFrontmatter({ slug: 'abc', read: true }, 'b')).toBe(
      '---\nslug: abc\nread: true\n---\n\nb\n',
    )
  })

  it('round-trips a list through parseFrontmatterFull', () => {
    const file = composeFrontmatter({ tags: ['x', 'y: z'] }, 'body')
    const { data } = splitFrontmatter(file)
    // splitFrontmatter's flat view skips the list...
    expect(data.tags).toBeUndefined()
    // ...but parseFrontmatterFull reads it back exactly.
    const inner = file.slice(4, file.indexOf('\n---\n', 4))
    expect(parseFrontmatterFull(inner).tags).toEqual(['x', 'y: z'])
  })
})

describe('mergeFrontmatter — list values', () => {
  it('replaces an app-owned list, preserving foreign keys', () => {
    const existing = '---\ntags:\n  - old\naliases: [keep]\n---\n\nbody'
    expect(mergeFrontmatter(existing, { tags: ['new', 'two'] }, 'body')).toBe(
      '---\naliases: [keep]\ntags:\n  - new\n  - two\n---\n\nbody\n',
    )
  })

  it('drops an app-owned list when cleared to empty', () => {
    const existing = '---\ntags:\n  - a\nslug: s\n---\n\nb'
    expect(mergeFrontmatter(existing, { tags: [], slug: 's' }, 'b')).toBe(
      '---\nslug: s\n---\n\nb\n',
    )
  })
})

describe('parseFrontmatterFull', () => {
  it('returns scalars as strings and sequences as arrays', () => {
    const out = parseFrontmatterFull('slug: abc\ntags:\n  - a\n  - b')
    expect(out).toEqual({ slug: 'abc', tags: ['a', 'b'] })
  })

  it('parseFrontmatterBlock still drops the list (scalar-only contract)', () => {
    expect(parseFrontmatterBlock('slug: abc\ntags:\n  - a')).toEqual({ slug: 'abc' })
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

  // ── Parser-swap invariants ──────────────────────────────────────────
  // These pin behaviour that must survive swapping the hand-rolled scalar
  // reader for the YAML library: they are green against both parsers.

  it('tolerates a trailing space on the closing fence', () => {
    const { data, body } = splitFrontmatter('---\nslug: abc\n---  \n\nbody')
    expect(data).toEqual({ slug: 'abc' })
    expect(body).toBe('body')
  })

  it('tolerates a trailing tab on the closing fence', () => {
    const { data, body } = splitFrontmatter('---\nslug: abc\n---\t\n\nbody')
    expect(data).toEqual({ slug: 'abc' })
    expect(body).toBe('body')
  })

  it('reads a double-quoted wikilink value with the quotes stripped', () => {
    const { data } = splitFrontmatter('---\nrelated: "[[ISA]]"\n---\n\nbody')
    expect(data).toEqual({ related: '[[ISA]]' })
  })

  it('treats an empty block (no lines between fences) as no frontmatter', () => {
    // `---\n---` has nothing to slice as a block; both parsers fall back to
    // the whole input as body rather than inventing an empty data object.
    const raw = '---\n---\n\nbody'
    expect(splitFrontmatter(raw)).toEqual({ data: {}, body: raw })
  })

  it('reads an empty value as an empty string', () => {
    const { data } = splitFrontmatter('---\nk:\nslug: ok\n---\n\nb')
    expect(data).toEqual({ k: '', slug: 'ok' })
  })

  it('keeps the exact text of a numeric-looking value (no coercion)', () => {
    // A value that looks like a number must round-trip as its original
    // string — leading zeros and large magnitudes intact.
    const { data } = splitFrontmatter(
      '---\ncode: 007\narchivedAt: 1718000000000\n---\n\nb',
    )
    expect(data).toEqual({ code: '007', archivedAt: '1718000000000' })
  })

  // ── Intended divergences from the old hand parser ────────────────────
  // The YAML library understands structure the line-based parser only
  // faked. These behaviours are deliberate and covered so a future change
  // can't silently regress them. No app read consumer inspects nested
  // keys, so production behaviour is unaffected.

  it('skips a nested list value (the flat contract cannot hold it)', () => {
    // Old parser surfaced `tags` as an empty string and dropped the items;
    // now the whole non-scalar key is skipped, and siblings still parse.
    const { data } = splitFrontmatter(
      '---\ntags:\n  - a\n  - b\nslug: keep\n---\n\nbody',
    )
    expect(data).toEqual({ slug: 'keep' })
  })

  it('does not leak a nested map key to the top level', () => {
    // Old parser mis-read the indented `a: 1` as a top-level `a` key; the
    // library scopes it correctly, so only the real top-level key remains.
    const { data } = splitFrontmatter(
      '---\nmeta:\n  a: 1\nslug: keep\n---\n\nbody',
    )
    expect(data).toEqual({ slug: 'keep' })
  })

  it('recovers sibling scalars when one line is malformed YAML', () => {
    // `bad: x: y` is invalid YAML (an unquoted `: ` reads as a nested map);
    // silent parsing keeps the valid keys rather than discarding the whole
    // block the way a throwing parse would.
    const { data } = splitFrontmatter(
      '---\ncreatedAt: 2026-07-19\nslug: abc\nbad: x: y\n---\n\nbody',
    )
    expect(data).toEqual({ createdAt: '2026-07-19', slug: 'abc' })
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
