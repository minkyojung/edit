import { describe, expect, it } from 'vitest'
import { looseFindRange, looseReplace } from './looseMatch'

describe('looseFindRange — exact (tier 1)', () => {
  it('finds a verbatim substring', () => {
    const body = '나이: 47살\n성별: 남자'
    expect(looseFindRange(body, '나이: 47살')).toEqual({ start: 0, end: 7 })
  })

  it('finds a verbatim sub-line phrase', () => {
    const body = '- 나이: 47살'
    const r = looseFindRange(body, '47살')
    expect(r).not.toBeNull()
    expect(body.slice(r!.start, r!.end)).toBe('47살')
  })

  it('returns null when there is no plausible match', () => {
    expect(looseFindRange('성별: 남자', '나이: 47살')).toBeNull()
  })
})

describe('looseFindRange — normalized line match (tier 2)', () => {
  it('matches across a leading bullet marker, returning the content range', () => {
    // body has "- " bullet; needle omits it. The matched range should
    // cover only the content so a replace preserves the marker.
    const body = '- 나이: 47살\n- 성별: 남자'
    const r = looseFindRange(body, '나이: 47살')
    expect(r).not.toBeNull()
    expect(body.slice(r!.start, r!.end)).toBe('나이: 47살')
  })

  it('matches across colon-spacing drift', () => {
    const body = '- 나이 : 47살'
    const r = looseFindRange(body, '나이: 47살')
    expect(r).not.toBeNull()
    expect(body.slice(r!.start, r!.end)).toBe('나이 : 47살')
  })

  it('matches across wikilink form drift (rendered label vs [[..]])', () => {
    // body carries the markdown form; anchor lost the brackets
    const body = '- [[Company A]] 로부터 입사 제의를 받음'
    const r = looseFindRange(body, 'Company A 로부터 입사 제의를 받음')
    expect(r).not.toBeNull()
    expect(body.slice(r!.start, r!.end)).toBe('[[Company A]] 로부터 입사 제의를 받음')
  })

  it('matches across trailing whitespace', () => {
    const body = '나이: 47살   '
    const r = looseFindRange(body, '나이: 47살')
    expect(r).not.toBeNull()
    expect(body.slice(r!.start, r!.end)).toBe('나이: 47살')
  })

  it('matches a multi-line needle only when exact (tier 1, markers kept)', () => {
    const body = '# Clark\n\n- 나이: 47살\n- 성별: 남자\n'
    const r = looseFindRange(body, '- 나이: 47살\n- 성별: 남자')
    expect(r).not.toBeNull()
    expect(body.slice(r!.start, r!.end)).toBe('- 나이: 47살\n- 성별: 남자')
  })

  it('does NOT loosely match a multi-line needle (avoids inner-marker damage)', () => {
    // markers omitted + multi-line → tier 2 is single-line only, so no match
    const body = '- 나이: 47살\n- 성별: 남자'
    expect(looseFindRange(body, '나이: 47살\n성별: 남자')).toBeNull()
  })
})

describe('looseReplace', () => {
  it('exact: swaps the verbatim region', () => {
    expect(looseReplace('나이: 47살', '나이: 47살', '나이: 45살')).toBe('나이: 45살')
  })

  it('bullet drift: preserves the leading marker', () => {
    expect(
      looseReplace('- 나이: 47살\n- 성별: 남자', '나이: 47살', '나이: 45살'),
    ).toBe('- 나이: 45살\n- 성별: 남자')
  })

  it('returns null when nothing matches', () => {
    expect(looseReplace('성별: 남자', '나이: 47살', '나이: 45살')).toBeNull()
  })
})
