import { describe, expect, it } from 'vitest'
import { firstNonEmptyLine, stripDuplicateTitleHeading } from './markdownText'

describe('firstNonEmptyLine', () => {
  it('returns the first line when the body starts with content', () => {
    expect(firstNonEmptyLine('Sarah Kim\n\nVP of Operations')).toBe('Sarah Kim')
  })

  it('skips leading blank lines', () => {
    expect(firstNonEmptyLine('\n\n  \nReal content here')).toBe('Real content here')
  })

  it('skips lines that contain only whitespace', () => {
    expect(firstNonEmptyLine('   \n\t\n  hello  ')).toBe('hello')
  })

  it('skips lines that are zero-width characters only', () => {
    // ZWS + ZWJ + BOM — variants the legacy seed body sometimes carries
    expect(firstNonEmptyLine('​\n‍\n﻿\nactual line')).toBe('actual line')
  })

  it('trims the returned line', () => {
    expect(firstNonEmptyLine('   spaced out   ')).toBe('spaced out')
  })

  it('returns null for an empty string', () => {
    expect(firstNonEmptyLine('')).toBeNull()
  })

  it('returns null when every line is effectively empty', () => {
    expect(firstNonEmptyLine('\n  \n\t\n​')).toBeNull()
  })
})

describe('stripDuplicateTitleHeading', () => {
  it('strips a leading H1 that equals the title (+ one trailing blank)', () => {
    const r = stripDuplicateTitleHeading('# Peter\n\n- 리서치 인턴으로 합류', 'Peter')
    expect(r.removed).toBe('Peter')
    expect(r.body).toBe('- 리서치 인턴으로 합류')
  })

  it('keeps a leading H1 that differs from the title', () => {
    const r = stripDuplicateTitleHeading('# 배경\n내용', 'Peter')
    expect(r.removed).toBeNull()
    expect(r.body).toBe('# 배경\n내용')
  })

  it('matches after trimming whitespace around the heading text', () => {
    const r = stripDuplicateTitleHeading('#   Peter  \n본문', 'Peter')
    expect(r.removed).toBe('Peter')
    expect(r.body).toBe('본문')
  })

  it('ignores a non-heading first line even if it equals the title', () => {
    const r = stripDuplicateTitleHeading('Peter\n본문', 'Peter')
    expect(r.removed).toBeNull()
    expect(r.body).toBe('Peter\n본문')
  })

  it('skips leading blank lines before the heading', () => {
    const r = stripDuplicateTitleHeading('\n\n# Peter\n본문', 'Peter')
    expect(r.removed).toBe('Peter')
    expect(r.body).toBe('본문')
  })

  it('does nothing for an empty title', () => {
    const r = stripDuplicateTitleHeading('# Peter\n본문', '')
    expect(r.removed).toBeNull()
    expect(r.body).toBe('# Peter\n본문')
  })

  it('does not match an H2 with the same text', () => {
    const r = stripDuplicateTitleHeading('## Peter\n본문', 'Peter')
    expect(r.removed).toBeNull()
  })
})
