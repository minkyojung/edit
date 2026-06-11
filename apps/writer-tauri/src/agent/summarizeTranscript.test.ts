import { describe, expect, it } from 'vitest'
import { splitSummary, withSummary } from './summarizeTranscript'

describe('splitSummary', () => {
  it('separates the TL;DR dek from the key points body', () => {
    const summary = '## TL;DR\nA talk about procrastination.\n\n## Key points\n- [00:12] a\n- [02:05] b'
    expect(splitSummary(summary)).toEqual({
      dek: 'A talk about procrastination.',
      body: '## Key points\n- [00:12] a\n- [02:05] b',
    })
  })

  it('treats the whole thing as the dek when there is no key-points section', () => {
    expect(splitSummary('## TL;DR\nJust a one-liner.')).toEqual({
      dek: 'Just a one-liner.',
      body: '',
    })
  })
})

describe('withSummary', () => {
  it('puts the summary on top and the transcript under a heading', () => {
    const summary = '## TL;DR\nA talk about procrastination.'
    const transcript = '[00:12] So in college...'
    expect(withSummary(summary, transcript)).toBe(
      '## TL;DR\nA talk about procrastination.\n\n## Transcript\n\n[00:12] So in college...\n',
    )
  })

  it('trims stray surrounding whitespace from both parts', () => {
    expect(withSummary('  summary  ', '  body  ')).toBe(
      'summary\n\n## Transcript\n\nbody\n',
    )
  })

  it('yields just the transcript when the summary body is empty', () => {
    expect(withSummary('', '[00:12] a')).toBe('## Transcript\n\n[00:12] a\n')
  })
})
