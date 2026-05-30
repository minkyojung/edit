import { describe, expect, it } from 'vitest'
import { Schema, type Node as PMNode } from '@milkdown/kit/prose/model'
import { findTextRange } from './anchorSearch'
import { looseFindRange } from '@/lib/looseMatch'

// Minimal schema with a `link` MARK (wikilinks render as a link mark on
// the label text, which splits a line into multiple text nodes — the
// exact shape that broke the old per-text-node search).
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    bullet_list: { group: 'block', content: 'list_item+' },
    list_item: { content: 'paragraph+' },
    text: { group: 'inline' },
  },
  marks: { link: { attrs: { href: {} } } },
})

const link = (href: string) => schema.marks.link.create({ href })
function para(...content: PMNode[]): PMNode {
  return schema.nodes.paragraph.create(null, content)
}
function item(text: string): PMNode {
  return schema.nodes.list_item.create(null, para(schema.text(text)))
}
function doc(...blocks: PMNode[]): PMNode {
  return schema.nodes.doc.create(null, blocks)
}

describe('findTextRange', () => {
  it('matches plain text in a paragraph', () => {
    const d = doc(para(schema.text('나이: 47살')))
    const r = findTextRange(d, '나이: 47살')
    expect(r).not.toBeNull()
    expect(d.textBetween(r!.from, r!.to)).toBe('나이: 47살')
  })

  it('matches across a wikilink (link mark) line, given a [[..]] anchor', () => {
    // line is split into 3 text nodes: "이전에 " / "Sera"(link) / " 와 일함"
    const d = doc(
      para(
        schema.text('이전에 '),
        schema.text('Sera', [link('note:abc')]),
        schema.text(' 와 일함'),
      ),
    )
    // anchor comes in markdown form with brackets; rendered text has none
    const r = findTextRange(d, '[[Sera]] 와 일함')
    expect(r).not.toBeNull()
    expect(d.textBetween(r!.from, r!.to)).toBe('Sera 와 일함')
  })

  it('matches a list item across its bullet marker', () => {
    const d = doc(schema.nodes.bullet_list.create(null, [item('31살')]))
    const r = findTextRange(d, '- 31살')
    expect(r).not.toBeNull()
    expect(d.textBetween(r!.from, r!.to)).toBe('31살')
  })

  it('returns the LAST occurrence when opts.last', () => {
    const d = doc(para(schema.text('x')), para(schema.text('x')))
    const first = findTextRange(d, 'x')
    const last = findTextRange(d, 'x', { last: true })
    expect(last!.from).toBeGreaterThan(first!.from)
  })

  it('returns null when nothing matches', () => {
    const d = doc(para(schema.text('hello')))
    expect(findTextRange(d, 'goodbye')).toBeNull()
  })

  it('tier-2: matches an indented bullet anchor (the divergence case)', () => {
    // rendered text has no indent/marker; anchor came in markdown form
    const d = doc(para(schema.text('나이: 47')))
    const r = findTextRange(d, '  - 나이: 47')
    expect(r).not.toBeNull()
    expect(d.textBetween(r!.from, r!.to)).toBe('나이: 47')
  })

  it('tier-2: matches colon-spacing / trailing-space drift', () => {
    const d = doc(para(schema.text('나이: 47')))
    expect(findTextRange(d, '나이 : 47')).not.toBeNull()
    expect(findTextRange(d, '나이: 47   ')).not.toBeNull()
  })
})

describe('findTextRange ⟺ looseFindRange (the invariant the two surfaces must keep)', () => {
  // Same single-line content in both representations: rendered PM doc
  // and the on-disk markdown. Editor placement (findTextRange) and disk
  // apply (looseFindRange) must agree on whether each anchor resolves.
  const bodyMd = '- 나이: 47'
  const d = doc(schema.nodes.bullet_list.create(null, [item('나이: 47')]))

  const anchors = [
    '나이: 47', // exact
    '- 나이: 47', // with marker
    '나이 : 47', // colon-spacing drift
    '나이: 47   ', // trailing whitespace
    '성별: 남자', // absent → both must say "no"
  ]

  for (const t of anchors) {
    it(`agree on ${JSON.stringify(t)}`, () => {
      const editor = findTextRange(d, t) !== null
      const disk = looseFindRange(bodyMd, t) !== null
      expect(editor).toBe(disk)
    })
  }

  it('the present anchors actually resolve (not trivially both-null)', () => {
    expect(findTextRange(d, '나이 : 47')).not.toBeNull()
    expect(looseFindRange(bodyMd, '나이 : 47')).not.toBeNull()
  })
})
