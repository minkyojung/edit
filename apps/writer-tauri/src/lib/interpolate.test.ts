import { describe, it, expect } from 'vitest'
import { interpolate, CURSOR_TOKEN } from './interpolate'

// Tue 2026-07-14, 09:05 local. Fixed so date/week math is deterministic.
const NOW = new Date(2026, 6, 14, 9, 5)

describe('interpolate', () => {
  it('replaces date tokens (today/tomorrow/yesterday) in local YYYY-MM-DD', () => {
    expect(interpolate('{{today}}', { now: NOW })).toBe('2026-07-14')
    expect(interpolate('{{tomorrow}}', { now: NOW })).toBe('2026-07-15')
    expect(interpolate('{{yesterday}}', { now: NOW })).toBe('2026-07-13')
    expect(interpolate('{{date}}', { now: NOW })).toBe('2026-07-14')
  })

  it('replaces time tokens (now/time) in HH:mm with zero-padding', () => {
    expect(interpolate('{{now}}', { now: NOW })).toBe('09:05')
    expect(interpolate('{{time}}', { now: NOW })).toBe('09:05')
  })

  it('resolves this-week/next-week to that week Monday', () => {
    // 2026-07-14 is a Tuesday ⇒ this week's Monday is 07-13, next is 07-20.
    expect(interpolate('{{this-week}}', { now: NOW })).toBe('2026-07-13')
    expect(interpolate('{{next-week}}', { now: NOW })).toBe('2026-07-20')
  })

  it('leaves {{cursor}} and unknown tokens untouched', () => {
    expect(interpolate(CURSOR_TOKEN, { now: NOW })).toBe(CURSOR_TOKEN)
    expect(interpolate('{{nope}}', { now: NOW })).toBe('{{nope}}')
  })

  it('tolerates inner whitespace and is case-insensitive', () => {
    expect(interpolate('{{ Today }}', { now: NOW })).toBe('2026-07-14')
  })

  it('replaces multiple tokens in one pass', () => {
    expect(interpolate('# {{today}}\nnext: {{next-week}}', { now: NOW })).toBe(
      '# 2026-07-14\nnext: 2026-07-20',
    )
  })
})
