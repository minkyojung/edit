import { describe, expect, it } from 'vitest'
import { Schema, type Node as PMNode } from '@milkdown/kit/prose/model'
import { computePendingHunks } from './computePendingHunks'
import { looseReplace } from './looseMatch'
import { findTextRange } from '@/editor/anchorSearch'

// Minimal block schema whose structure matches what remark parses the
// snapshot markdown into (one paragraph per blank-line-separated block),
// so buildBlockMap's parallel walk lines up.
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    text: { group: 'inline' },
  },
  marks: {},
})

function para(text: string): PMNode {
  return schema.nodes.paragraph.create(null, text ? schema.text(text) : undefined)
}
function doc(...paras: string[]): PMNode {
  return schema.nodes.doc.create(null, paras.map(para))
}

describe('computePendingHunks', () => {
  it('lifts a single removed paragraph to its block range', () => {
    const snapshot = 'first para\n\nsecond para'
    const after = 'second para'
    const d = doc('first para', 'second para')
    const hunks = computePendingHunks(snapshot, after, d)
    expect(hunks).not.toBeNull()
    const removes = hunks!.filter((h) => h.type === 'remove')
    expect(removes.length).toBe(1)
    // The remove hunk should cover the first paragraph's PM range.
    const para1End = d.child(0).nodeSize // doc-relative end of para 0
    expect(removes[0]).toMatchObject({ type: 'remove', pmFrom: 0, pmTo: para1End })
  })

  it('returns null on AST/PM structure mismatch (caller falls back to unplaced)', () => {
    // snapshot parses to 2 blocks, doc has 1 → buildBlockMap bails.
    const hunks = computePendingHunks('a\n\nb', 'a', doc('only one'))
    expect(hunks).toBeNull()
  })
})

// The multi-line replace placement fallback that resolveAnchor uses when
// a `before` spans block boundaries: findTextRange (block-by-block) can't
// pin it, but looseReplace (the disk matcher Keep uses) locates it, and
// computePendingHunks lifts the resulting diff to PM block ranges. This
// keeps "what's drawn" and "what Keep applies" on the SAME matcher.
describe('multi-line replace fallback (looseReplace ▸ computePendingHunks)', () => {
  it('places a cross-paragraph replace that findTextRange alone cannot', () => {
    const bodyMd = '아버지는 건강하시다.\n\n어머니는 부산에 사신다.'
    const d = doc('아버지는 건강하시다.', '어머니는 부산에 사신다.')
    const before = '아버지는 건강하시다.\n\n어머니는 부산에 사신다.'
    const after = '부모님 두 분 다 건강하시다.'

    // The old single-block search gives up — this is the "Open Review
    // panel" (unplaced) case before the fallback existed.
    expect(findTextRange(d, before)).toBeNull()

    // The fallback reproduces the disk apply, then derives hunks.
    const newBody = looseReplace(bodyMd, before, after)
    expect(newBody).toBe(after)
    const hunks = computePendingHunks(bodyMd, newBody!, d)
    expect(hunks).not.toBeNull()
    expect(hunks!.some((h) => h.type === 'remove')).toBe(true)
    expect(hunks!.some((h) => h.type === 'add')).toBe(true)
    // Every PM position the hunks point at must be inside the doc.
    for (const h of hunks!) {
      if (h.type === 'remove') {
        expect(h.pmFrom).toBeGreaterThanOrEqual(0)
        expect(h.pmTo).toBeLessThanOrEqual(d.content.size)
      } else {
        expect(h.pmAt).toBeGreaterThanOrEqual(0)
        expect(h.pmAt).toBeLessThanOrEqual(d.content.size)
      }
    }
  })

  it('stays unplaced when the before is absent from the body', () => {
    const bodyMd = '아버지는 건강하시다.'
    // looseReplace returns null → resolveAnchor falls through to unplaced.
    expect(looseReplace(bodyMd, '존재하지 않는\n여러 줄 텍스트', 'x')).toBeNull()
  })
})
