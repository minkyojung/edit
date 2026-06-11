import { describe, expect, it } from 'vitest'
import {
  approxDurationSec,
  linkifyTimestamps,
  parseYoutubeId,
  parseYoutubeTimestampLink,
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

describe('linkifyTimestamps', () => {
  const ID = 'dQw4w9WgXcQ'

  it('converts [mm:ss] into a deep-link at the right second', () => {
    expect(linkifyTimestamps('[00:44] and then', ID)).toBe(
      '[00:44](https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=44s) and then',
    )
  })

  it('handles [h:mm:ss] timestamps', () => {
    expect(linkifyTimestamps('[1:01:01] late', ID)).toBe(
      '[1:01:01](https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3661s) late',
    )
  })

  it('linkifies every timestamp in a multi-line body', () => {
    const out = linkifyTimestamps('[00:12] a\n\n[02:05] b', ID)
    expect(out).toContain('[00:12](https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=12s)')
    expect(out).toContain('[02:05](https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=125s)')
  })

  it('is idempotent — already-linked timestamps are left alone', () => {
    const once = linkifyTimestamps('[00:44] x', ID)
    expect(linkifyTimestamps(once, ID)).toBe(once)
  })

  it('leaves non-timestamp bracketed text untouched', () => {
    expect(linkifyTimestamps('[note] and [TODO]', ID)).toBe('[note] and [TODO]')
  })
})

describe('parseYoutubeTimestampLink', () => {
  it('round-trips a link emitted by linkifyTimestamps', () => {
    const href = linkifyTimestamps('[02:05]', 'dQw4w9WgXcQ').match(/\((.+)\)/)![1]
    expect(parseYoutubeTimestampLink(href)).toEqual({ videoId: 'dQw4w9WgXcQ', sec: 125 })
  })

  it('parses the seconds off the t=Ns param', () => {
    expect(
      parseYoutubeTimestampLink('https://www.youtube.com/watch?v=abc12345678&t=44s'),
    ).toEqual({ videoId: 'abc12345678', sec: 44 })
  })

  it('returns null for non-timestamp / non-youtube links', () => {
    expect(parseYoutubeTimestampLink('https://www.youtube.com/watch?v=abc12345678')).toBeNull()
    expect(parseYoutubeTimestampLink('https://example.com/watch?v=x&t=10s')).toBeNull()
    expect(parseYoutubeTimestampLink('not a url')).toBeNull()
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
