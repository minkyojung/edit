import { describe, expect, it } from 'vitest'
import { firstNonEmptyLine } from './markdownText'

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
