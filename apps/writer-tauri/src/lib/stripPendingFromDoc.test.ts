import { describe, expect, it } from 'vitest'
import { Schema, type Node as PMNode } from '@milkdown/kit/prose/model'
import { stripPendingFromDoc } from './stripPendingFromDoc'

// Minimal schema mirroring the shape stripPendingFromDoc cares about:
// block containers (paragraph, bullet_list/list_item) + a `proofSuggestion`
// mark carrying a `kind` attr. stripPendingFromDoc is schema-agnostic — it
// only reads `mark.type.name` + `mark.attrs.kind` and deletes ranges — so a
// hand-rolled schema is enough to exercise it without standing up Milkdown.
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
      attrs: { kind: { default: 'replace' } },
    },
  },
})

const insert = schema.marks.proofSuggestion.create({ kind: 'insert' })

/** text node, optionally carrying the insert mark. */
function t(str: string, pending = false): PMNode {
  return schema.text(str, pending ? [insert] : null)
}
function para(...content: PMNode[]): PMNode {
  return schema.nodes.paragraph.create(null, content)
}
function item(...paras: PMNode[]): PMNode {
  return schema.nodes.list_item.create(null, paras)
}
function list(...items: PMNode[]): PMNode {
  return schema.nodes.bullet_list.create(null, items)
}
function doc(...blocks: PMNode[]): PMNode {
  return schema.nodes.doc.create(null, blocks)
}

describe('stripPendingFromDoc — no pending content', () => {
  it('returns the SAME doc reference when no insert marks exist', () => {
    const d = doc(para(t('hello')), para(t('world')))
    expect(stripPendingFromDoc(d)).toBe(d)
  })
})

describe('stripPendingFromDoc — block-level pending', () => {
  it('drops a paragraph whose entire text is insert-marked', () => {
    const d = doc(para(t('keep me')), para(t('pending add', true)))
    const out = stripPendingFromDoc(d)
    expect(out.childCount).toBe(1)
    expect(out.textContent).toBe('keep me')
  })

  it('drops a pending list_item but keeps the surrounding list', () => {
    const d = doc(
      list(item(para(t('real bullet'))), item(para(t('pending bullet', true)))),
    )
    const out = stripPendingFromDoc(d)
    expect(out.textContent).toBe('real bullet')
    // the bullet_list survives with exactly one item
    const listNode = out.child(0)
    expect(listNode.type.name).toBe('bullet_list')
    expect(listNode.childCount).toBe(1)
  })

  it('drops an entire list when every item is pending', () => {
    const d = doc(
      para(t('intro')),
      list(item(para(t('p1', true))), item(para(t('p2', true)))),
    )
    const out = stripPendingFromDoc(d)
    expect(out.childCount).toBe(1)
    expect(out.textContent).toBe('intro')
  })
})

describe('stripPendingFromDoc — inline-partial pending', () => {
  it('removes only the marked phrase inside an otherwise-real paragraph', () => {
    const d = doc(para(t('before '), t('PENDING', true), t(' after')))
    const out = stripPendingFromDoc(d)
    expect(out.childCount).toBe(1)
    expect(out.textContent).toBe('before  after')
  })
})

describe('stripPendingFromDoc — preserves legitimate empty blocks', () => {
  it('does not drop a user empty paragraph (no text descendants)', () => {
    const d = doc(para(), para(t('body')))
    const out = stripPendingFromDoc(d)
    expect(out.childCount).toBe(2)
    expect(out.textContent).toBe('body')
  })
})
