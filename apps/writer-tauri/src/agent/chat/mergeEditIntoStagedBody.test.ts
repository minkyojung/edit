import { describe, expect, it } from 'vitest'
import { mergeEditIntoStagedBody } from './toPendingChange'

// Pure-function tests for the race fix's core piece: given a body already
// staged this turn (from an earlier Write/Edit), a SECOND (or later) tool
// call's edit is re-derived against that staged body — not treated as
// "the whole new body" (that assumption only holds for the very first call).
describe('mergeEditIntoStagedBody', () => {
  it('Write replaces the entire staged body', () => {
    const r = mergeEditIntoStagedBody('* 첫 줄', 'Write', { content: '* 새 내용' })
    expect(r.text).toBe('* 새 내용')
    expect(r.placement).toEqual({ kind: 'ok' })
  })

  it('Edit replaces old_string within the staged body (not "new_string is the whole body")', () => {
    const staged = '# 결혼식 준비\n\n* 날짜: 미정\n* 장소: 미정'
    const r = mergeEditIntoStagedBody(staged, 'Edit', {
      old_string: '* 날짜: 미정',
      new_string: '* 날짜: 10월 12일',
    })
    expect(r.text).toBe('# 결혼식 준비\n\n* 날짜: 10월 12일\n* 장소: 미정')
    expect(r.placement).toEqual({ kind: 'ok' })
  })

  it('MultiEdit applies each pair sequentially against the evolving staged body', () => {
    const staged = 'A\nB\nC'
    const r = mergeEditIntoStagedBody(staged, 'MultiEdit', {
      edits: [
        { old_string: 'A', new_string: 'A2' },
        { old_string: 'C', new_string: 'C2' },
      ],
    })
    expect(r.text).toBe('A2\nB\nC2')
    expect(r.placement).toEqual({ kind: 'ok' })
  })
})

// "Unchanged" used to be the caller's only signal, which cannot separate an
// anchor the model got wrong from an edit the PREVIOUS call this turn already
// made. Both left the body identical; only one is a failure.
describe('mergeEditIntoStagedBody — why nothing changed', () => {
  it("an old_string that isn't there is ABSENT, and names it", () => {
    const staged = '기존 본문'
    const r = mergeEditIntoStagedBody(staged, 'Edit', {
      old_string: '없는 문자열',
      new_string: '무언가',
    })
    expect(r.text).toBe(staged)
    expect(r.placement).toEqual({ kind: 'absent', editIndex: 0, target: '없는 문자열' })
  })

  it('an edit the earlier call already staged is NOOP, not absent', () => {
    // The first tool call this turn staged '반갑습니다'; this second call proposes
    // the same swap. Reporting absent would have the model re-propose it forever.
    const staged = '# 인사\n\n반갑습니다'
    const r = mergeEditIntoStagedBody(staged, 'Edit', {
      old_string: '안녕하세요',
      new_string: '반갑습니다',
    })
    expect(r.text).toBe(staged)
    expect(r.placement).toEqual({ kind: 'noop' })
  })

  it('an old_string matching several places is AMBIGUOUS, not absent', () => {
    const staged = 'dup\ndup'
    const r = mergeEditIntoStagedBody(staged, 'Edit', { old_string: 'dup', new_string: 'x' })
    expect(r.text).toBe(staged)
    expect(r.placement).toEqual({ kind: 'ambiguous', editIndex: 0, target: 'dup' })
  })

  it('an unknown tool name builds no edits at all → noop', () => {
    const staged = '본문 그대로'
    const r = mergeEditIntoStagedBody(staged, 'NotebookEdit', { anything: true })
    expect(r.text).toBe(staged)
    expect(r.placement).toEqual({ kind: 'noop' })
  })
})
