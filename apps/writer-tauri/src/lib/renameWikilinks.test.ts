import { describe, expect, it } from 'vitest'
import { rewriteWikilinkTitle } from './renameWikilinks'

describe('rewriteWikilinkTitle', () => {
  it('rewrites an exact-title link', () => {
    expect(rewriteWikilinkTitle('see [[Tom]] here', 'Tom', 'Thomas')).toBe(
      'see [[Thomas]] here',
    )
  })

  it('is case-insensitive on the match (resolver semantics)', () => {
    expect(rewriteWikilinkTitle('[[tom]] and [[TOM]]', 'Tom', 'Thomas')).toBe(
      '[[Thomas]] and [[Thomas]]',
    )
  })

  it('preserves an alias', () => {
    expect(rewriteWikilinkTitle('[[Tom|the boss]]', 'Tom', 'Thomas')).toBe(
      '[[Thomas|the boss]]',
    )
  })

  it('leaves non-matching links alone', () => {
    expect(rewriteWikilinkTitle('[[Tomato]] [[Tommy]]', 'Tom', 'Thomas')).toBe(
      '[[Tomato]] [[Tommy]]',
    )
  })

  it('rewrites multiple occurrences and ignores plain text', () => {
    expect(
      rewriteWikilinkTitle('Tom wrote [[Tom]] about [[Tom]].', 'Tom', 'Thomas'),
    ).toBe('Tom wrote [[Thomas]] about [[Thomas]].')
  })

  it('matches titles with surrounding whitespace inside the brackets', () => {
    expect(rewriteWikilinkTitle('[[ Tom ]]', 'Tom', 'Thomas')).toBe('[[Thomas]]')
  })

  it('handles the escaped `\\[\\[..\\]\\]` disk form, preserving escapes', () => {
    expect(rewriteWikilinkTitle('x \\[\\[Tom\\]\\] y', 'Tom', 'Thomas')).toBe(
      'x \\[\\[Thomas\\]\\] y',
    )
  })
})
