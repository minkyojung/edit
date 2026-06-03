import { describe, expect, it } from 'vitest'
import { canonicalizeLine, leadingMarkerLength } from './lineCanonical'

describe('leadingMarkerLength', () => {
  it('counts bullet + trailing space', () => {
    expect(leadingMarkerLength('- item')).toBe(2)
  })
  it('counts indent before the marker too', () => {
    expect(leadingMarkerLength('  - item')).toBe(4)
  })
  it('counts heading / ordered / quote markers', () => {
    expect(leadingMarkerLength('## H')).toBe(3)
    expect(leadingMarkerLength('1. x')).toBe(3)
    expect(leadingMarkerLength('> q')).toBe(2)
  })
  it('is 0 with no marker', () => {
    expect(leadingMarkerLength('plain text')).toBe(0)
  })
})

describe('canonicalizeLine', () => {
  it('strips an indented bullet marker (the editor/disk divergence case)', () => {
    expect(canonicalizeLine('  - item')).toBe('item')
  })
  it('strips marker + collapses colon spacing', () => {
    expect(canonicalizeLine('- 나이 : 47')).toBe('나이:47')
  })
  it('reduces wikilinks to their label', () => {
    expect(canonicalizeLine('[[Sera]] 와 일함')).toBe('Sera 와 일함')
    expect(canonicalizeLine('[Sera](note:abc) 와 일함')).toBe('Sera 와 일함')
  })
  it('collapses internal whitespace runs and trims', () => {
    expect(canonicalizeLine('31살  학생  ')).toBe('31살 학생')
  })
  it('agrees regardless of which drift form an anchor arrives in', () => {
    // the whole point: these all canonicalize to the same string
    const target = '나이:47'
    expect(canonicalizeLine('나이: 47')).toBe(target)
    expect(canonicalizeLine('나이 : 47')).toBe(target)
    expect(canonicalizeLine('  - 나이: 47')).toBe(target)
    expect(canonicalizeLine('[[나이]]: 47')).toBe('나이:47')
  })
})
