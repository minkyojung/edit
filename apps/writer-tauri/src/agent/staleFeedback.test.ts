import { describe, expect, it } from 'vitest'
import { buildStaleReason } from './staleFeedback'

describe('buildStaleReason', () => {
  it('names the file, the changed lines, and inlines the latest body', () => {
    const msg = buildStaleReason(
      'wiki/회의록.md',
      [{ from: 4, to: 4 }],
      '# 회의록\n- 민교\n- 윌리엄',
    )
    expect(msg).toContain('wiki/회의록.md')
    expect(msg).toContain('line(s) 4')
    expect(msg).toContain('- 윌리엄')
    // Must steer the model off resubmitting the stale version.
    expect(msg).toMatch(/do NOT resubmit/i)
  })

  it('formats a multi-line range as from-to', () => {
    const msg = buildStaleReason('a.md', [{ from: 2, to: 5 }], 'body')
    expect(msg).toContain('line(s) 2-5')
  })

  it('truncates an oversized body but keeps the head', () => {
    const big = 'x'.repeat(9000)
    const msg = buildStaleReason('a.md', [{ from: 1, to: 1 }], big)
    expect(msg).toContain('truncated')
    expect(msg.length).toBeLessThan(big.length + 500)
  })
})
