import { describe, expect, it } from 'vitest'
import { mergeEditIntoStagedBody } from './toPendingChange'

// Pure-function tests for the race fix's core piece: given a body already
// staged this turn (from an earlier Write/Edit), a SECOND (or later) tool
// call's edit is re-derived against that staged body — not treated as
// "the whole new body" (that assumption only holds for the very first call).
describe('mergeEditIntoStagedBody', () => {
  it('Write replaces the entire staged body', () => {
    const merged = mergeEditIntoStagedBody('* 첫 줄', 'Write', { content: '* 새 내용' })
    expect(merged).toBe('* 새 내용')
  })

  it('Edit replaces old_string within the staged body (not "new_string is the whole body")', () => {
    const staged = '# 결혼식 준비\n\n* 날짜: 미정\n* 장소: 미정'
    const merged = mergeEditIntoStagedBody(staged, 'Edit', {
      old_string: '* 날짜: 미정',
      new_string: '* 날짜: 10월 12일',
    })
    expect(merged).toBe('# 결혼식 준비\n\n* 날짜: 10월 12일\n* 장소: 미정')
  })

  it('MultiEdit applies each pair sequentially against the evolving staged body', () => {
    const staged = 'A\nB\nC'
    const merged = mergeEditIntoStagedBody(staged, 'MultiEdit', {
      edits: [
        { old_string: 'A', new_string: 'A2' },
        { old_string: 'C', new_string: 'C2' },
      ],
    })
    expect(merged).toBe('A2\nB\nC2')
  })

  it("returns the body UNCHANGED when the Edit's old_string isn't found — callers detect this via === to surface a failure instead of a silent no-op", () => {
    const staged = '기존 본문'
    const merged = mergeEditIntoStagedBody(staged, 'Edit', {
      old_string: '없는 문자열',
      new_string: '무언가',
    })
    expect(merged).toBe(staged)
  })

  it('an unknown tool name is a no-op (unchanged body)', () => {
    const staged = '본문 그대로'
    const merged = mergeEditIntoStagedBody(staged, 'NotebookEdit', { anything: true })
    expect(merged).toBe(staged)
  })
})
