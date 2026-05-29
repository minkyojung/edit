import { describe, expect, it } from 'vitest'
import { splitEdit } from './intraEditDiff'

describe('splitEdit', () => {
  it('isolates an inline value change', () => {
    const s = splitEdit('나이: 45살', '나이: 48살')
    expect(s.removed).toBe('5')
    expect(s.added).toBe('8')
    expect(s.prefixLen).toBe(5) // "나이: 4" (나,이,:,space,4)
    expect(s.suffixLen).toBe(1) // "살"
  })

  it('treats an insertion-expressed-as-replace as a pure add', () => {
    const s = splitEdit('성별: 남자', '성별: 남자\n직업: 청소부')
    expect(s.removed).toBe('')
    expect(s.added).toBe('\n직업: 청소부')
    expect(s.prefixLen).toBe('성별: 남자'.length)
    expect(s.suffixLen).toBe(0)
  })

  it('handles a pure deletion', () => {
    const s = splitEdit('keep this gone', 'keep this')
    expect(s.removed).toBe(' gone')
    expect(s.added).toBe('')
  })

  it('returns empty removed/added for identical strings', () => {
    const s = splitEdit('same', 'same')
    expect(s.removed).toBe('')
    expect(s.added).toBe('')
  })

  it('does not let prefix and suffix overlap', () => {
    // "aa" → "aaa": prefix consumes both a's, suffix must not re-count
    const s = splitEdit('aa', 'aaa')
    expect(s.prefixLen + s.suffixLen).toBeLessThanOrEqual(2)
    expect(s.added).toBe('a')
    expect(s.removed).toBe('')
  })

  it('handles a fully-different replacement', () => {
    const s = splitEdit('cat', 'dog')
    expect(s.removed).toBe('cat')
    expect(s.added).toBe('dog')
  })
})
