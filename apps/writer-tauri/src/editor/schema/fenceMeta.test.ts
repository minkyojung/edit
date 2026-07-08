import { describe, expect, it } from 'vitest'
import { buildFenceMeta, decodeVizIdFromMeta } from './fenceMeta'

describe('fence meta — viz id', () => {
  it('round-trips an id with the nanoid alphabet', () => {
    const meta = buildFenceMeta('aB1_c-2', '')
    expect(meta).toBe('v:aB1_c-2')
    expect(decodeVizIdFromMeta(meta ?? undefined)).toBe('aB1_c-2')
  })

  it('coexists with proof marks, id first / base64 trailing', () => {
    const meta = buildFenceMeta('abc', 'proof:eyJ4IjoxfQ==')
    expect(meta).toBe('v:abc proof:eyJ4IjoxfQ==')
    expect(decodeVizIdFromMeta(meta ?? undefined)).toBe('abc')
  })

  it('returns null meta when both tokens are empty', () => {
    expect(buildFenceMeta('', '')).toBeNull()
  })

  it('keeps proof-only meta unchanged (no viz token)', () => {
    expect(buildFenceMeta('', 'proof:xx')).toBe('proof:xx')
  })

  it('decodes id regardless of token order, and "" when absent', () => {
    expect(decodeVizIdFromMeta('proof:xx v:zzz')).toBe('zzz')
    expect(decodeVizIdFromMeta('proof:xx')).toBe('')
    expect(decodeVizIdFromMeta('')).toBe('')
    expect(decodeVizIdFromMeta(undefined)).toBe('')
  })
})
