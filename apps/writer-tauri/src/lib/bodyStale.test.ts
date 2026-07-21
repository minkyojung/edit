import { describe, expect, it } from 'vitest'
import { bodiesEqual, changedLineRanges } from './bodyStale'

describe('bodiesEqual', () => {
  it('treats a missing trailing newline as equal', () => {
    expect(bodiesEqual('a\nb', 'a\nb\n')).toBe(true)
    expect(bodiesEqual('', '')).toBe(true)
  })

  it('reports a real content difference as not equal', () => {
    expect(bodiesEqual('a\nb', 'a\nc')).toBe(false)
    expect(bodiesEqual('a\nb', 'a\nb\nc')).toBe(false)
  })
})

describe('changedLineRanges', () => {
  it('is empty when bodies match', () => {
    expect(changedLineRanges('a\nb\nc', 'a\nb\nc')).toEqual([])
  })

  it('reports the appended line — the scenario line 4', () => {
    // base = 3 lines, user typed a 4th while the AI generated.
    const base = '# 회의록\n## 참석자\n- 민교'
    const latest = '# 회의록\n## 참석자\n- 민교\n- 윌리엄'
    const ranges = changedLineRanges(base, latest)
    expect(ranges).toEqual([{ from: 4, to: 4 }])
  })

  it('reports an in-place edit at its line', () => {
    const ranges = changedLineRanges('a\nb\nc', 'a\nB\nc')
    expect(ranges).toEqual([{ from: 2, to: 2 }])
  })
})
