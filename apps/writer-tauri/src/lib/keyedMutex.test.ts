import { describe, it, expect } from 'vitest'
import { runExclusive } from './keyedMutex'

describe('runExclusive', () => {
  it('serializes same-key read-modify-write — no lost update', async () => {
    // A shared "document" with an await BETWEEN read and write — the exact shape
    // of applyToWikiPage. Without serialization the later writer reads the same
    // old value and clobbers the earlier append (only one letter would survive).
    let doc = ''
    const rmwAppend = (s: string) =>
      runExclusive('k', async () => {
        const old = doc
        await new Promise((r) => setTimeout(r, 5))
        doc = old + s
      })
    await Promise.all([rmwAppend('A'), rmwAppend('B'), rmwAppend('C')])
    expect(doc).toBe('ABC') // all three landed, in call order
  })

  it('runs different keys in parallel', async () => {
    const order: string[] = []
    await Promise.all([
      runExclusive('x', async () => {
        await new Promise((r) => setTimeout(r, 15))
        order.push('x')
      }),
      runExclusive('y', async () => {
        order.push('y')
      }),
    ])
    // y (no delay) finishes before x (15ms) → not serialized across keys.
    expect(order).toEqual(['y', 'x'])
  })

  it('a rejected op does not block the next on the same key', async () => {
    const ran: string[] = []
    const p1 = runExclusive('k2', async () => {
      throw new Error('boom')
    }).catch(() => ran.push('p1-caught'))
    const p2 = runExclusive('k2', async () => {
      ran.push('p2-ran')
    })
    await Promise.all([p1, p2])
    expect(ran).toContain('p2-ran')
  })
})
