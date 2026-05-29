import { describe, expect, it } from 'vitest'
import { Schema, Fragment, type Node as PMNode } from '@milkdown/kit/prose/model'
import { anchorToTargets } from './pendingTargets'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    text: { group: 'inline' },
  },
  marks: { proofSuggestion: { attrs: { kind: { default: 'replace' }, id: { default: null } } } },
})

function doc(...texts: string[]): PMNode {
  return schema.nodes.doc.create(
    null,
    texts.map((t) => schema.nodes.paragraph.create(null, t ? schema.text(t) : undefined)),
  )
}
/** Fake parser — one paragraph holding the markdown verbatim. Enough
 * to assert the adapter passes content through + computes positions;
 * the real parser is Milkdown's and is exercised live, not here. */
const parse = (md: string): Fragment =>
  Fragment.from(schema.nodes.paragraph.create(null, md ? schema.text(md) : undefined))

describe('anchorToTargets — add', () => {
  it('maps a placed add to a single insert at the block boundary', () => {
    const d = doc('body')
    const res = { status: 'placed' as const, anchor: { insertAt: d.content.size, applyReady: true } }
    const out = anchorToTargets(res, 'c1:e1', { kind: 'add', after: 'new line' }, d, parse)
    expect(out.deletes).toEqual([])
    expect(out.inserts).toHaveLength(1)
    expect(out.inserts[0].markId).toBe('c1:e1')
    expect(out.inserts[0].insertPos).toBe(d.content.size)
    expect(out.inserts[0].content.firstChild?.textContent).toBe('new line')
  })

  it('skips an add with empty content', () => {
    const d = doc('body')
    const res = { status: 'placed' as const, anchor: { insertAt: d.content.size, applyReady: true } }
    const out = anchorToTargets(res, 'c1:e1', { kind: 'add', after: '' }, d, parse)
    expect(out.inserts).toEqual([])
  })
})

describe('anchorToTargets — inline replace / delete are NOT mark-native', () => {
  it('returns no targets for an inline replace-with-before (decoration path keeps it)', () => {
    const d = doc('age 47')
    const res = {
      status: 'placed' as const,
      anchor: { from: 1, to: 7, insertAt: 7, applyReady: true },
    }
    const out = anchorToTargets(
      res,
      'c1:e1',
      { kind: 'replace', before: 'age 47', after: 'age 45' },
      d,
      parse,
    )
    expect(out.inserts).toEqual([])
    expect(out.deletes).toEqual([])
  })

  it('routes "add a new line after anchor" (replace) to a single insert of the delta', () => {
    const d = doc('성별: 남자')
    const res = {
      status: 'placed' as const,
      anchor: { from: 1, to: 7, insertAt: 7, applyReady: true },
    }
    const out = anchorToTargets(
      res,
      'c1:e1',
      { kind: 'replace', before: '성별: 남자', after: '성별: 남자\n직업: 청소부' },
      d,
      parse,
    )
    expect(out.deletes).toEqual([])
    expect(out.inserts).toHaveLength(1)
    // only the added delta — the unchanged anchor is NOT re-inserted
    expect(out.inserts[0].content.firstChild?.textContent).toBe('\n직업: 청소부')
  })

  it('returns no targets for a pure delete', () => {
    const d = doc('remove me')
    const res = { status: 'placed' as const, anchor: { from: 1, to: 10, applyReady: true } }
    const out = anchorToTargets(res, 'c1:e1', { kind: 'delete', before: 'remove me' }, d, parse)
    expect(out.inserts).toEqual([])
    expect(out.deletes).toEqual([])
  })
})

describe('anchorToTargets — hunks (whole-file replace)', () => {
  it('maps remove hunks to deletes and add hunks to inserts, keyed per hunk', () => {
    const d = doc('alpha', 'beta')
    const res = {
      status: 'hunks' as const,
      applyReady: true,
      hunks: [
        { type: 'remove' as const, pmFrom: 1, pmTo: 6 },
        { type: 'add' as const, pmAt: d.content.size, content: 'gamma' },
      ],
    }
    const out = anchorToTargets(res, 'c1:e1', { kind: 'replace', after: 'x' }, d, parse)
    expect(out.deletes).toEqual([{ markId: 'c1:e1:hunk:0', from: 1, to: 6 }])
    expect(out.inserts).toHaveLength(1)
    expect(out.inserts[0].markId).toBe('c1:e1:hunk:1')
    expect(out.inserts[0].insertPos).toBe(d.content.size)
    expect(out.inserts[0].content.firstChild?.textContent).toBe('gamma')
  })
})

describe('anchorToTargets — unplaced / silent', () => {
  it('returns empty targets', () => {
    const d = doc('body')
    expect(anchorToTargets({ status: 'unplaced' }, 'c1:e1', { kind: 'add', after: 'x' }, d, parse)).toEqual({
      inserts: [],
      deletes: [],
    })
    expect(anchorToTargets({ status: 'silent' }, 'c1:e1', { kind: 'add', after: 'x' }, d, parse)).toEqual({
      inserts: [],
      deletes: [],
    })
  })
})
