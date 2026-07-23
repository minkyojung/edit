// Headless proof for the media (video/audio) widget. Placement/reveal is now
// owned by the v2 block field (covered in v2/blocks tests); what lives HERE is
// the pure detection (`detectMedia`) and the widget identity (`eq`) that keeps a
// <video>/<audio> element — and its playback position — alive across unrelated
// edits.

import { describe, expect, it } from 'vitest'
import { detectMedia, MediaWidget } from './mediaCards'

describe('detectMedia', () => {
  it('parses a <video> tag (kind + src)', () => {
    const m = detectMedia('<video src="https://example.com/a.mp4" controls></video>')
    expect(m).toEqual({ kind: 'video', src: 'https://example.com/a.mp4', title: '' })
  })

  it('parses an <audio> tag with a title attribute', () => {
    const m = detectMedia('<audio src="https://example.com/a.mp3" title="Clip" controls></audio>')
    expect(m).toEqual({ kind: 'audio', src: 'https://example.com/a.mp3', title: 'Clip' })
  })

  it('tolerates leading/trailing whitespace', () => {
    const m = detectMedia('  <video src="x.mp4"></video>  ')
    expect(m?.kind).toBe('video')
  })

  it('returns null for a non-media paragraph or a src-less tag', () => {
    expect(detectMedia('just some prose')).toBeNull()
    expect(detectMedia('<video controls></video>')).toBeNull()
  })
})

describe('MediaWidget.eq — no-remount identity', () => {
  it('same kind/src/title → eq (media element NOT torn down, playback survives)', () => {
    const a = new MediaWidget('video', 'a.mp4', '')
    const b = new MediaWidget('video', 'a.mp4', '')
    expect(a.eq(b)).toBe(true)
  })

  it('a changed src → non-eq (widget rebuilds)', () => {
    const a = new MediaWidget('video', 'a.mp4', '')
    const b = new MediaWidget('video', 'aX.mp4', '')
    expect(a.eq(b)).toBe(false)
  })

  it('a changed title → non-eq', () => {
    const a = new MediaWidget('audio', 'a.mp3', 'Clip')
    const b = new MediaWidget('audio', 'a.mp3', 'Clip 2')
    expect(a.eq(b)).toBe(false)
  })
})
