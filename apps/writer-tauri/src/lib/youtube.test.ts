import { describe, expect, it } from 'vitest'
import {
  approxDurationSec,
  parseYoutubeId,
  transcriptToMarkdown,
  type TranscriptSegment,
} from './youtube'

describe('parseYoutubeId', () => {
  it('reads the id from a standard watch URL', () => {
    expect(parseYoutubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
  })

  it('reads youtu.be, shorts, and embed forms', () => {
    expect(parseYoutubeId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
    expect(parseYoutubeId('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
    expect(parseYoutubeId('https://www.youtube.com/embed/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
  })

  it('keeps extra query params from a watch URL', () => {
    expect(parseYoutubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&list=x')).toBe(
      'dQw4w9WgXcQ',
    )
  })

  it('accepts a bare 11-char id', () => {
    expect(parseYoutubeId('dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
  })

  it('returns null for non-YouTube or malformed input', () => {
    expect(parseYoutubeId('https://example.com/watch?v=dQw4w9WgXcQ')).toBeNull()
    expect(parseYoutubeId('https://www.youtube.com/watch?v=tooShort')).toBeNull()
    expect(parseYoutubeId('not a url')).toBeNull()
    expect(parseYoutubeId('')).toBeNull()
  })
})

describe('transcriptToMarkdown', () => {
  const segs: TranscriptSegment[] = [
    { text: 'Hello there', offset: 1000, duration: 2000 },
    { text: 'this is a test', offset: 3500, duration: 2000 },
    { text: 'second window now', offset: 40000, duration: 2000 },
  ]

  it('groups segments into timestamped windows', () => {
    // First two fall in the same 30s window (anchored at 1s → [00:01]);
    // the third starts a new window at 40s → [00:40].
    expect(transcriptToMarkdown(segs)).toBe(
      '[00:01] Hello there this is a test\n\n[00:40] second window now',
    )
  })

  it('decodes HTML entities and collapses whitespace', () => {
    const e: TranscriptSegment[] = [
      { text: 'rock &amp; roll&#39;s\n  best', offset: 0 },
    ]
    expect(transcriptToMarkdown(e)).toBe("[00:00] rock & roll's best")
  })

  it('drops empty/whitespace-only segments (window anchors to first real one)', () => {
    const e: TranscriptSegment[] = [
      { text: '   ', offset: 0 },
      { text: 'real text', offset: 1000 },
    ]
    expect(transcriptToMarkdown(e)).toBe('[00:01] real text')
  })

  it('uses an h:mm:ss stamp past an hour', () => {
    const e: TranscriptSegment[] = [{ text: 'late', offset: 3661 * 1000 }]
    expect(transcriptToMarkdown(e)).toBe('[1:01:01] late')
  })

  it('returns empty string for no segments', () => {
    expect(transcriptToMarkdown([])).toBe('')
  })
})

describe('approxDurationSec', () => {
  it('uses the last segment end (offset + duration)', () => {
    expect(
      approxDurationSec([
        { text: 'a', offset: 0, duration: 2000 },
        { text: 'b', offset: 210000, duration: 3000 },
      ]),
    ).toBe(213)
  })

  it('is undefined for an empty transcript', () => {
    expect(approxDurationSec([])).toBeUndefined()
  })
})
