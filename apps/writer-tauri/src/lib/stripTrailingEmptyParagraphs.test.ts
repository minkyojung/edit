import { describe, expect, it } from 'vitest'
import { Schema, type Node as PMNode } from '@milkdown/kit/prose/model'
import { stripTrailingEmptyParagraphs } from './stripTrailingEmptyParagraphs'

// Minimal schema mirroring the real doc's `block+` shape — enough to
// exercise the trailing-empty-paragraph trim without the live editor.
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    heading: { group: 'block', content: 'inline*' },
    code_block: { group: 'block', content: 'text*', marks: '' },
    text: { group: 'inline' },
  },
  marks: {},
})

const p = (t?: string): PMNode =>
  schema.nodes.paragraph.create(null, t ? schema.text(t) : undefined)
const h = (t: string): PMNode => schema.nodes.heading.create(null, schema.text(t))
const code = (t: string): PMNode =>
  schema.nodes.code_block.create(null, schema.text(t))
const doc = (...blocks: PMNode[]): PMNode => schema.nodes.doc.create(null, blocks)

const bodies = (d: PMNode): string[] => {
  const out: string[] = []
  d.forEach((c) => out.push(`${c.type.name}:${c.textContent}`))
  return out
}

describe('stripTrailingEmptyParagraphs', () => {
  it('drops a single trailing empty paragraph', () => {
    const out = stripTrailingEmptyParagraphs(doc(p('안녕하세요'), p()))
    expect(bodies(out)).toEqual(['paragraph:안녕하세요'])
  })

  it('drops multiple trailing empty paragraphs', () => {
    const out = stripTrailingEmptyParagraphs(doc(p('a'), p(), p(), p()))
    expect(bodies(out)).toEqual(['paragraph:a'])
  })

  it('keeps a genuinely empty note as one empty paragraph (schema minimum)', () => {
    const input = doc(p())
    const out = stripTrailingEmptyParagraphs(input)
    expect(out).toBe(input) // same reference — nothing to trim
    expect(bodies(out)).toEqual(['paragraph:'])
  })

  it('returns the same reference when the last block has content', () => {
    const input = doc(p('a'), p('b'))
    expect(stripTrailingEmptyParagraphs(input)).toBe(input)
  })

  it('does not trim a non-paragraph trailing block', () => {
    const out = stripTrailingEmptyParagraphs(doc(p('a'), code('x')))
    expect(bodies(out)).toEqual(['paragraph:a', 'code_block:x'])
  })

  it('preserves empty paragraphs that sit between real content', () => {
    const out = stripTrailingEmptyParagraphs(doc(p('a'), p(), p('b'), p()))
    expect(bodies(out)).toEqual(['paragraph:a', 'paragraph:', 'paragraph:b'])
  })

  it('trims trailing empty paragraphs after a heading', () => {
    const out = stripTrailingEmptyParagraphs(doc(h('Title'), p()))
    expect(bodies(out)).toEqual(['heading:Title'])
  })
})
