import { describe, it, expect } from 'vitest'
import { computeDocStats } from './docStatsStore'

describe('computeDocStats', () => {
  it('counts words and characters of plain text', () => {
    expect(computeDocStats('hello world')).toEqual({ words: 2, chars: 11 })
  })

  it('treats an empty / whitespace-only doc as zero words', () => {
    expect(computeDocStats('')).toEqual({ words: 0, chars: 0 })
    expect(computeDocStats('   \n\t ')).toEqual({ words: 0, chars: 6 })
  })

  it('collapses runs of whitespace (newlines, tabs) between words', () => {
    expect(computeDocStats('a\n\nb\tc   d').words).toBe(4)
  })

  it('counts space-delimited Korean 어절', () => {
    expect(computeDocStats('안녕 세상 입니다').words).toBe(3)
  })

  it('chars is the raw length, including markdown syntax', () => {
    expect(computeDocStats('# Title').chars).toBe(7)
  })
})
