import { describe, it, expect } from 'vitest'
import { stripFrontmatter, chunkText, inferSourceLabel } from './parseImport'

describe('stripFrontmatter', () => {
  it('removes a leading YAML frontmatter block', () => {
    const input = '---\ntitle: foo\ntags: [a, b]\n---\n# Body\n\nHello.'
    expect(stripFrontmatter(input)).toBe('# Body\n\nHello.')
  })

  it('returns the input unchanged when there is no frontmatter', () => {
    const input = '# Just a heading\n\nNo metadata up top.'
    expect(stripFrontmatter(input)).toBe(input)
  })

  it('leaves mid-document `---` separators alone (horizontal rules)', () => {
    const input = '# A\n\nFirst section.\n\n---\n\nSecond section.'
    expect(stripFrontmatter(input)).toBe(input)
  })

  it('returns the input unchanged when the closing `---` is missing', () => {
    const input = '---\ntitle: foo\n\n# Body never closed.'
    expect(stripFrontmatter(input)).toBe(input)
  })

  it('handles CRLF line endings', () => {
    const input = '---\r\ntitle: foo\r\n---\r\nBody.'
    expect(stripFrontmatter(input)).toBe('Body.')
  })
})

describe('chunkText', () => {
  it('returns a single-element array for short input', () => {
    const input = 'Just a short note about Sarah.'
    expect(chunkText(input)).toEqual([input])
  })

  it('splits on paragraph boundaries when over the budget', () => {
    // Each "Para" is ~60 bytes; 6 paragraphs ~ 360 bytes — with a
    // 150-byte budget we expect ≥ 3 chunks, none exceeding 150
    // bytes, each starting at a paragraph boundary.
    const paras = Array.from({ length: 6 }, (_, i) =>
      `Para ${i}: ${'x'.repeat(50)}`,
    )
    const input = paras.join('\n\n')
    const chunks = chunkText(input, 150)
    expect(chunks.length).toBeGreaterThanOrEqual(3)
    const encoder = new TextEncoder()
    for (const c of chunks) {
      expect(encoder.encode(c).length).toBeLessThanOrEqual(150)
    }
  })

  it('falls back to line boundaries when a paragraph is too big', () => {
    // One paragraph, many lines, total > budget.
    const lines = Array.from({ length: 20 }, (_, i) => `line${i}`)
    const input = lines.join('\n')
    const chunks = chunkText(input, 30)
    expect(chunks.length).toBeGreaterThan(1)
    const encoder = new TextEncoder()
    for (const c of chunks) {
      expect(encoder.encode(c).length).toBeLessThanOrEqual(30)
    }
  })

  it('keeps multibyte characters intact at chunk boundaries', () => {
    // Korean (3 bytes per char). Force-split path exercises the
    // codepoint-aware splitter.
    const input = '한'.repeat(50) // 150 bytes
    const chunks = chunkText(input, 30) // each chunk ≤ 30 bytes = 10 chars
    const encoder = new TextEncoder()
    for (const c of chunks) {
      expect(encoder.encode(c).length).toBeLessThanOrEqual(30)
      // No replacement chars (would appear if we split mid-byte and
      // the decoder had to recover).
      expect(c).not.toContain('�')
    }
    // Round-trip: concatenation preserves the original content.
    expect(chunks.join('')).toBe(input)
  })

  it('throws on non-positive maxBytes', () => {
    expect(() => chunkText('x', 0)).toThrow(RangeError)
    expect(() => chunkText('x', -1)).toThrow(RangeError)
  })
})

describe('inferSourceLabel', () => {
  it('extracts basename from a POSIX absolute path', () => {
    expect(inferSourceLabel('/Users/foo/Notes/sarah.md')).toBe('imported/sarah.md')
  })

  it('extracts basename from a Windows absolute path', () => {
    expect(inferSourceLabel('C:\\Users\\foo\\notes\\bar.txt')).toBe('imported/bar.txt')
  })

  it('handles a bare filename', () => {
    expect(inferSourceLabel('sarah.md')).toBe('imported/sarah.md')
  })

  it('falls back to a non-empty label for empty / whitespace input', () => {
    expect(inferSourceLabel('')).toBe('imported/note')
    expect(inferSourceLabel('   ')).toBe('imported/note')
  })
})
