import { describe, expect, it } from 'vitest'
import { Schema, Fragment, type Node as PMNode } from '@milkdown/kit/prose/model'
import { EditorState } from '@milkdown/kit/prose/state'
import {
  reconcilePendingInserts,
  reconcilePendingDeletes,
  commitSuggestionInDoc,
  blockBoundaryAfter,
  type DesiredInsert,
  type DesiredDelete,
} from './markReconcile'
import { stripPendingFromDoc } from '@/lib/stripPendingFromDoc'

// Same minimal schema shape as stripPendingFromDoc.test — block
// containers + a `proofSuggestion` mark with a `kind` + `id` attr.
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    bullet_list: { group: 'block', content: 'list_item+' },
    list_item: { content: 'paragraph+' },
    text: { group: 'inline' },
  },
  marks: {
    proofSuggestion: {
      attrs: { kind: { default: 'replace' }, id: { default: null } },
    },
  },
})

function para(text: string): PMNode {
  return schema.nodes.paragraph.create(null, text ? schema.text(text) : undefined)
}
function item(text: string): PMNode {
  return schema.nodes.list_item.create(null, para(text))
}
function list(...items: PMNode[]): PMNode {
  return schema.nodes.bullet_list.create(null, items)
}
function doc(...blocks: PMNode[]): PMNode {
  return schema.nodes.doc.create(null, blocks)
}
/** A fresh, UNMARKED paragraph fragment — what the caller hands the
 * engine (the engine stamps the insert mark itself). */
function content(text: string): Fragment {
  return Fragment.from(para(text))
}

/** A paragraph whose text carries a proofSuggestion mark of `kind`
 * with markId `id`. Used to build already-materialised pending docs. */
function markedPara(text: string, kind: string, id: string): PMNode {
  const mark = schema.marks.proofSuggestion.create({ kind, id })
  return schema.nodes.paragraph.create(null, schema.text(text, [mark]))
}

/** Apply the reconcile transaction (if any) and return the new doc. */
function run(d: PMNode, desired: DesiredInsert[]): PMNode {
  const state = EditorState.create({ doc: d })
  const tr = reconcilePendingInserts(state, desired)
  return tr ? state.apply(tr).doc : d
}

function runCommit(d: PMNode, changeId: string): PMNode {
  const state = EditorState.create({ doc: d })
  const tr = commitSuggestionInDoc(state, changeId)
  return tr ? state.apply(tr).doc : d
}

function runDeletes(d: PMNode, desired: DesiredDelete[]): PMNode {
  const state = EditorState.create({ doc: d })
  const tr = reconcilePendingDeletes(state, desired)
  return tr ? state.apply(tr).doc : d
}

/** Collect the kinds of every proofSuggestion mark in the doc. */
function pendingKinds(node: PMNode): string[] {
  const kinds: string[] = []
  node.descendants((d) => {
    for (const m of d.marks) {
      if (m.type.name === 'proofSuggestion') kinds.push(m.attrs.kind as string)
    }
    return true
  })
  return kinds
}

describe('blockBoundaryAfter', () => {
  it('returns the boundary right after the top-level block holding the pos', () => {
    // doc: <p>AB</p><p>CD</p>  → boundary after para1 is 4
    const d = doc(para('AB'), para('CD'))
    // pos 2 is between A and B (inside para1)
    expect(blockBoundaryAfter(d, 2)).toBe(4)
  })

  it('returns content.size when the pos is inside the last block', () => {
    const d = doc(para('AB'), para('CD'))
    // pos 6 is inside para2 → after para2 == content.size
    expect(blockBoundaryAfter(d, 6)).toBe(d.content.size)
  })

  it('returns content.size for an append position', () => {
    const d = doc(para('AB'))
    expect(blockBoundaryAfter(d, d.content.size)).toBe(d.content.size)
  })

  it('lifts a nested (list_item) pos to the top-level list boundary', () => {
    // doc: <ul><li><p>X</p></li></ul><p>tail</p>
    const d = doc(list(item('X')), para('tail'))
    // a position inside "X" should resolve to just after the whole list
    const listSize = d.child(0).nodeSize
    expect(blockBoundaryAfter(d, 3)).toBe(listSize)
  })
})

describe('reconcilePendingInserts — insert', () => {
  it('inserts a missing pending block carrying the insert mark', () => {
    const d = doc(para('body'))
    const out = run(d, [
      { markId: 'c1:e1', content: content('proposed'), insertPos: d.content.size },
    ])
    expect(out.childCount).toBe(2)
    expect(out.child(1).textContent).toBe('proposed')
    // the inserted text carries proofSuggestion/insert with the id
    const textNode = out.child(1).child(0)
    const mark = textNode.marks.find((m) => m.type.name === 'proofSuggestion')
    expect(mark?.attrs.kind).toBe('insert')
    expect(mark?.attrs.id).toBe('c1:e1')
  })

  it('keeps the inserted content OFF disk — strip restores the clean doc', () => {
    const d = doc(para('body'))
    const out = run(d, [
      { markId: 'c1:e1', content: content('proposed'), insertPos: d.content.size },
    ])
    // The whole point of Phase 0+1: a materialised pending add is
    // invisible to the serialization path.
    expect(stripPendingFromDoc(out).eq(d)).toBe(true)
  })

  it('is idempotent — a second reconcile with the same desired set is a no-op', () => {
    const d = doc(para('body'))
    const state1 = EditorState.create({ doc: d })
    const desired: DesiredInsert[] = [
      { markId: 'c1:e1', content: content('proposed'), insertPos: d.content.size },
    ]
    const tr1 = reconcilePendingInserts(state1, desired)
    expect(tr1).not.toBeNull()
    const doc2 = state1.apply(tr1!).doc
    const state2 = EditorState.create({ doc: doc2 })
    // insertPos is recomputed against the original body anchor by the
    // caller; here the desired entry already lives in the doc, so the
    // engine must detect it by markId and do nothing.
    const tr2 = reconcilePendingInserts(state2, [
      { markId: 'c1:e1', content: content('proposed'), insertPos: doc2.content.size },
    ])
    expect(tr2).toBeNull()
  })

  it('does nothing for an empty desired set on a clean doc', () => {
    const state = EditorState.create({ doc: doc(para('body')) })
    expect(reconcilePendingInserts(state, [])).toBeNull()
  })
})

describe('reconcilePendingDeletes', () => {
  // doc: <p>hello world</p> — text starts at pos 1, so "world" is [7,12).
  const base = () => doc(para('hello world'))
  const worldRange: DesiredDelete = { markId: 'd1', from: 7, to: 12 }

  it('marks the target range with a delete-kind mark', () => {
    const out = runDeletes(base(), [worldRange])
    expect(pendingKinds(out)).toEqual(['delete'])
    // text is untouched — delete is a MARK, not a removal
    expect(out.textContent).toBe('hello world')
  })

  it('keeps delete-marked text ON disk (strip does not remove it)', () => {
    const out = runDeletes(base(), [worldRange])
    // strip only drops pending INSERT content; pending-delete text stays
    // because it is still present on disk until the user clicks Keep.
    expect(stripPendingFromDoc(out).textContent).toBe('hello world')
  })

  it('is idempotent', () => {
    const out = runDeletes(base(), [worldRange])
    const state = EditorState.create({ doc: out })
    expect(reconcilePendingDeletes(state, [worldRange])).toBeNull()
  })

  it('removes the delete mark when its id is no longer desired', () => {
    const marked = runDeletes(base(), [worldRange])
    const out = runDeletes(marked, [])
    expect(pendingKinds(out)).toEqual([])
    expect(out.textContent).toBe('hello world')
  })
})

describe('commitSuggestionInDoc', () => {
  it('keeps an inserted block by removing its mark (content survives, no pending left)', () => {
    const d = doc(para('body'), markedPara('새 항목', 'insert', 'c1:e1'))
    const out = runCommit(d, 'c1')
    expect(out.childCount).toBe(2)
    expect(out.child(1).textContent).toBe('새 항목')
    expect(pendingKinds(out)).toEqual([]) // mark gone → ordinary body
    // committed content is now real: strip leaves it untouched
    expect(stripPendingFromDoc(out).eq(out)).toBe(true)
  })

  it('removes a fully delete-marked block', () => {
    const d = doc(para('keep'), markedPara('지울 줄', 'delete', 'c1:e2'))
    const out = runCommit(d, 'c1')
    expect(out.childCount).toBe(1)
    expect(out.textContent).toBe('keep')
  })

  it('handles a replace (keep the insert, drop the delete) in one change', () => {
    const d = doc(
      markedPara('옛 값', 'delete', 'c1:e1'),
      markedPara('새 값', 'insert', 'c1:e1'),
    )
    const out = runCommit(d, 'c1')
    expect(out.textContent).toBe('새 값')
    expect(pendingKinds(out)).toEqual([])
  })

  it('only touches the requested change, leaving other changes pending', () => {
    const d = doc(markedPara('A', 'insert', 'c1:e1'), markedPara('B', 'insert', 'c2:e1'))
    const out = runCommit(d, 'c1')
    // c1 committed (no mark), c2 still pending (insert mark intact)
    expect(out.child(0).child(0).marks.length).toBe(0)
    expect(pendingKinds(out)).toEqual(['insert'])
  })

  it('returns null when the change has no marks in the doc', () => {
    const state = EditorState.create({ doc: doc(para('body')) })
    expect(commitSuggestionInDoc(state, 'c1')).toBeNull()
  })
})

describe('reconcilePendingInserts — list merge', () => {
  it('merges an inserted list into an adjacent same-type list (no sibling list)', () => {
    const d = doc(list(item('a'), item('b')))
    const out = run(d, [
      { markId: 'x', content: Fragment.from(list(item('new'))), insertPos: d.content.size },
    ])
    expect(out.childCount).toBe(1)
    expect(out.child(0).type.name).toBe('bullet_list')
    expect(out.child(0).childCount).toBe(3)
    expect(out.child(0).child(2).textContent).toBe('new')
    // still invisible to disk
    expect(stripPendingFromDoc(out).eq(d)).toBe(true)
  })

  it('does NOT merge a list into a paragraph — inserts as its own block', () => {
    const d = doc(para('intro'))
    const out = run(d, [
      { markId: 'x', content: Fragment.from(list(item('new'))), insertPos: d.content.size },
    ])
    expect(out.childCount).toBe(2)
    expect(out.child(1).type.name).toBe('bullet_list')
  })
})

describe('reconcilePendingInserts — remove', () => {
  it('removes a pending block whose markId is no longer desired', () => {
    // Materialise one, then reconcile to an empty desired set.
    const d = doc(para('body'))
    const materialised = run(d, [
      { markId: 'c1:e1', content: content('proposed'), insertPos: d.content.size },
    ])
    const out = run(materialised, [])
    expect(out.eq(d)).toBe(true)
  })

  it('removes only the dropped id and keeps other pending blocks', () => {
    const d = doc(para('body'))
    const both = run(d, [
      { markId: 'a', content: content('AAA'), insertPos: d.content.size },
      { markId: 'b', content: content('BBB'), insertPos: d.content.size },
    ])
    expect(both.textContent).toContain('AAA')
    expect(both.textContent).toContain('BBB')
    // keep only 'a'
    const out = run(both, [
      { markId: 'a', content: content('AAA'), insertPos: d.content.size },
    ])
    expect(out.textContent).toContain('AAA')
    expect(out.textContent).not.toContain('BBB')
  })
})
