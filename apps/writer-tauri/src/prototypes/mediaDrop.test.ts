// Headless proof for the media drop/paste pure helpers (classification +
// inserted markdown). The drop/paste DOM wiring is the thin shell.

import { describe, expect, it } from 'vitest'
import { classifyMedia, markdownForMedia } from './mediaDrop'

describe('classifyMedia', () => {
  it('routes by MIME prefix', () => {
    expect(classifyMedia({ type: 'image/png' })).toBe('image')
    expect(classifyMedia({ type: 'video/mp4' })).toBe('video')
    expect(classifyMedia({ type: 'audio/mpeg' })).toBe('audio')
  })
  it('ignores non-media', () => {
    expect(classifyMedia({ type: 'text/plain' })).toBeNull()
    expect(classifyMedia({ type: '' })).toBeNull()
  })
})

describe('markdownForMedia (matches card detection forms)', () => {
  it('image → ![]()', () => {
    expect(markdownForMedia('image', 'u', 'cat.png')).toBe('![cat.png](u)')
  })
  it('video → <video>', () => {
    expect(markdownForMedia('video', 'u', 'clip.mp4')).toBe('<video src="u" controls></video>')
  })
  it('audio → <audio> with title', () => {
    expect(markdownForMedia('audio', 'u', 'song.mp3')).toBe(
      '<audio src="u" title="song.mp3" controls></audio>',
    )
  })
})
