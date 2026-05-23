import { describe, expect, it } from 'vitest'
import { isStaleMark, isValidMark, type Mark } from './marks'

function makeMark(overrides: Partial<Mark> = {}): Mark {
  return {
    id: 'm1',
    kind: 'suggestion',
    suggestionType: 'replace',
    quote: 'hello world',
    startRel: 'AQ==',
    endRel: 'Ag==',
    content: 'goodbye world',
    status: 'pending',
    by: 'ai:claude-haiku-4-5',
    createdAt: '2026-05-15T17:00:00Z',
    ...overrides,
  }
}

describe('isValidMark', () => {
  it('accepts a complete suggestion mark', () => {
    expect(isValidMark(makeMark())).toBe(true)
  })

  it('accepts a comment mark with text', () => {
    expect(
      isValidMark(
        makeMark({ kind: 'comment', suggestionType: undefined, content: undefined, text: 'note' }),
      ),
    ).toBe(true)
  })

  it('accepts an authored mark without suggestionType', () => {
    expect(
      isValidMark(
        makeMark({ kind: 'authored', suggestionType: undefined, content: undefined }),
      ),
    ).toBe(true)
  })

  it('accepts a delete suggestion without content', () => {
    expect(
      isValidMark(makeMark({ suggestionType: 'delete', content: undefined })),
    ).toBe(true)
  })

  it('rejects non-object input', () => {
    expect(isValidMark(null)).toBe(false)
    expect(isValidMark(undefined)).toBe(false)
    expect(isValidMark('string')).toBe(false)
    expect(isValidMark(42)).toBe(false)
    expect(isValidMark([])).toBe(false)
  })

  it('rejects missing id', () => {
    expect(isValidMark(makeMark({ id: '' as unknown as string }))).toBe(false)
    const { id: _id, ...withoutId } = makeMark()
    expect(isValidMark(withoutId)).toBe(false)
  })

  it('rejects unknown kind', () => {
    expect(isValidMark(makeMark({ kind: 'flagged' as unknown as Mark['kind'] }))).toBe(false)
    expect(isValidMark(makeMark({ kind: 'provenance' as unknown as Mark['kind'] }))).toBe(false)
  })

  it('rejects suggestion missing suggestionType', () => {
    expect(isValidMark(makeMark({ suggestionType: undefined }))).toBe(false)
  })

  it('rejects unknown suggestionType', () => {
    expect(
      isValidMark(
        makeMark({ suggestionType: 'rewrite' as unknown as Mark['suggestionType'] }),
      ),
    ).toBe(false)
  })

  it('rejects insert/replace suggestion with empty content', () => {
    expect(isValidMark(makeMark({ suggestionType: 'insert', content: '' }))).toBe(false)
    expect(isValidMark(makeMark({ suggestionType: 'replace', content: '' }))).toBe(false)
  })

  it('rejects comment with empty text', () => {
    expect(
      isValidMark(
        makeMark({ kind: 'comment', suggestionType: undefined, content: undefined, text: '' }),
      ),
    ).toBe(false)
  })

  it('rejects missing anchor encoding', () => {
    expect(isValidMark(makeMark({ startRel: '' }))).toBe(false)
    expect(isValidMark(makeMark({ endRel: '' }))).toBe(false)
  })

  it('rejects unknown status', () => {
    expect(isValidMark(makeMark({ status: 'archived' as unknown as Mark['status'] }))).toBe(false)
  })

  it('accepts each valid status', () => {
    expect(isValidMark(makeMark({ status: 'pending' }))).toBe(true)
    expect(isValidMark(makeMark({ status: 'accepted' }))).toBe(true)
    expect(isValidMark(makeMark({ status: 'rejected' }))).toBe(true)
    expect(isValidMark(makeMark({ status: 'stale' }))).toBe(true)
  })

  it('rejects non-string optional fields when present', () => {
    expect(
      isValidMark(makeMark({ sourceSlug: 42 as unknown as Mark['sourceSlug'] })),
    ).toBe(false)
    expect(
      isValidMark(makeMark({ model: 42 as unknown as Mark['model'] })),
    ).toBe(false)
  })
})

describe('isStaleMark', () => {
  it('returns false when quote matches', () => {
    expect(isStaleMark(makeMark({ quote: 'hello' }), 'hello')).toBe(false)
  })

  it('returns true when quote differs', () => {
    expect(isStaleMark(makeMark({ quote: 'hello' }), 'world')).toBe(true)
  })

  it('returns false when mark quote is empty (treat as malformed, not drifted)', () => {
    expect(isStaleMark(makeMark({ quote: '' }), 'anything')).toBe(false)
  })

  it('distinguishes whitespace-only changes', () => {
    expect(isStaleMark(makeMark({ quote: 'hello' }), 'hello ')).toBe(true)
  })

  it('distinguishes case', () => {
    expect(isStaleMark(makeMark({ quote: 'Hello' }), 'hello')).toBe(true)
  })
})
