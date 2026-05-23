import { describe, expect, it } from 'vitest'
import { Schema } from '@milkdown/kit/prose/model'
import { findQuoteInNode } from './quote'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'text*', toDOM: () => ['p', 0] },
    text: { group: 'inline' },
  },
})

function makeDoc(...paragraphs: string[]) {
  return schema.node(
    'doc',
    null,
    paragraphs.map((p) =>
      schema.node('paragraph', null, p ? [schema.text(p)] : []),
    ),
  )
}

describe('findQuoteInNode', () => {
  it('finds a quote at the start of a paragraph', () => {
    const doc = makeDoc('hello world')
    expect(findQuoteInNode(doc, 'hello')).toEqual({ from: 1, to: 6 })
  })

  it('finds a quote mid-paragraph', () => {
    const doc = makeDoc('hello world')
    expect(findQuoteInNode(doc, 'world')).toEqual({ from: 7, to: 12 })
  })

  it('returns null for an empty quote', () => {
    expect(findQuoteInNode(makeDoc('hello'), '')).toBeNull()
  })

  it('returns null when the quote is absent', () => {
    expect(findQuoteInNode(makeDoc('hello world'), 'goodbye')).toBeNull()
  })

  it('finds the FIRST occurrence when the quote appears twice', () => {
    const doc = makeDoc('cat then cat')
    expect(findQuoteInNode(doc, 'cat')).toEqual({ from: 1, to: 4 })
  })

  it('returns null when the quote spans two paragraphs', () => {
    // Restriction is documented; cross-block matching is not supported.
    const doc = makeDoc('hello', 'world')
    expect(findQuoteInNode(doc, 'helloworld')).toBeNull()
  })

  it('finds a quote in the second paragraph', () => {
    const doc = makeDoc('first para', 'second para')
    // first para spans positions 1..11; paragraph break consumes 2 (close + open);
    // "second" starts at 13.
    expect(findQuoteInNode(doc, 'second')).toEqual({ from: 13, to: 19 })
  })

  it('case sensitive', () => {
    expect(findQuoteInNode(makeDoc('Hello'), 'hello')).toBeNull()
  })
})
