import { describe, expect, it } from 'vitest'
import { withSummary } from './summarizeTranscript'

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
