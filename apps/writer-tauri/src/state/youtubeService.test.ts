import { describe, expect, it } from 'vitest'
import { youtubeCaptureToDoc } from './youtubeService'
import type { YoutubeCapture } from '@/lib/youtube'

const capture: YoutubeCapture = {
  videoId: 'arj7oStGLkU',
  sourceUrl: 'https://www.youtube.com/watch?v=arj7oStGLkU',
  title: '  Inside the Mind of a Master Procrastinator  ',
  author: 'TED',
  thumbnailUrl: 'https://i.ytimg.com/vi/arj7oStGLkU/hq.jpg',
  durationSec: 843,
  bodyMarkdown: '[00:12] So in college...',
}

describe('youtubeCaptureToDoc', () => {
  it('maps a capture onto a generic inbox note, trimming the title', () => {
    expect(youtubeCaptureToDoc(capture, 'yt-1', '2026-06-11T00:00:00.000Z')).toEqual({
      slug: 'yt-1',
      type: 'note',
      title: 'Inside the Mind of a Master Procrastinator',
      relPath: 'inbox/Inside the Mind of a Master Procrastinator.md',
      createdAt: '2026-06-11T00:00:00.000Z',
      savedAt: '2026-06-11T00:00:00.000Z',
      sourceUrl: 'https://www.youtube.com/watch?v=arj7oStGLkU',
      siteName: 'TED', // channel rides on siteName
      videoId: 'arj7oStGLkU',
      durationSec: 843,
      thumbnailUrl: 'https://i.ytimg.com/vi/arj7oStGLkU/hq.jpg',
    })
  })

  it('carries the youtube-specific fields the frontmatter writer persists', () => {
    const doc = youtubeCaptureToDoc(capture, 'yt-2', '2026-06-11T00:00:00.000Z')
    // These are exactly the fields buildMetaForKnownDoc → frontmatter must
    // round-trip; if any is dropped here the note loses it on reload.
    expect(doc.videoId).toBe('arj7oStGLkU')
    expect(doc.durationSec).toBe(843)
    expect(doc.thumbnailUrl).toBe('https://i.ytimg.com/vi/arj7oStGLkU/hq.jpg')
  })
})
