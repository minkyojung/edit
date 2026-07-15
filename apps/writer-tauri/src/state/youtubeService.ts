// YouTube capture → note creation. A fetched transcript becomes a doc of
// type `youtube` at `inbox/<title>.md`, with its video metadata
// (url / channel / videoId / duration / thumbnail) carried on the
// KnownDoc and persisted — unlike article — through the `.md` frontmatter
// (youtube is the first frontmatter-native type; see usesFrontmatter).
//
// Mirrors articleService.ts createArticle: mint slug, register the catalog
// entry, seed the transcript as the body, then markSlugDirty + flushDirty
// so the note (frontmatter + body) lands on disk immediately.

import { generateClientSlug } from '@/lib/slug'
import { flushDirty, markSlugDirty } from '@/lib/docFileSync'
import {
  fetchYoutubeCapture,
  linkifyTimestamps,
  type YoutubeCapture,
} from '@/lib/youtube'
import { summarizeTranscript, withSummary } from '@/agent/summarizeTranscript'
import { sanitizeFilename } from '@/lib/docPaths'
import { getDefaultNoteFolder } from '@/state/settingsStore'
import { useDocsStore, type KnownDoc } from '@/state/docsStore'

/** Project a fetched capture onto a generic inbox `note`. Pure — the
 *  caller supplies the slug and timestamp. The video-ness is expressed by
 *  the `videoId` frontmatter field (not a doc type); the channel name
 *  rides on `siteName` (shared with the article fields). The note lives in
 *  `inbox/` — `relPath` IS its on-disk placement. */
export function youtubeCaptureToDoc(
  capture: YoutubeCapture,
  slug: string,
  now: string,
): KnownDoc {
  const title = capture.title.trim()
  return {
    slug,
    type: 'note',
    title,
    relPath: `${getDefaultNoteFolder()}/${sanitizeFilename(title)}.md`,
    createdAt: now,
    savedAt: now,
    sourceUrl: capture.sourceUrl,
    siteName: capture.author,
    videoId: capture.videoId,
    durationSec: capture.durationSec,
    thumbnailUrl: capture.thumbnailUrl,
  }
}

/** Create a youtube note from an already-fetched capture and return its
 *  slug (or null if the capture has no usable title). Registered in the
 *  catalog but NOT auto-opened — the caller decides whether to navigate. */
export async function createYoutubeNote(
  capture: YoutubeCapture,
): Promise<string | null> {
  if (!capture.title.trim()) return null

  const slug = generateClientSlug()
  const now = new Date().toISOString()
  const doc = youtubeCaptureToDoc(capture, slug, now)
  useDocsStore.setState((s) => ({ knownDocs: [...s.knownDocs, doc] }))

  // Seed the body: the video URL on its own line (renders as the inline
  // player) + the transcript. The note is a uniform markdown note — no
  // special header. Timestamps become deep-links so they're clickable
  // immediately, before the summary lands.
  try {
    const seed = linkifyTimestamps(
      `${capture.sourceUrl}\n\n${capture.bodyMarkdown}`,
      capture.videoId,
    )
    await useDocsStore.getState().seedDocBody(slug, seed)
  } catch (err) {
    console.warn('[youtube] createYoutubeNote seed failed', err)
  }

  // Force the note (frontmatter + body) to disk now so it survives a
  // restart even before any later edit.
  markSlugDirty(slug)
  void flushDirty()

  // Summarize in the background: the note shows instantly with the
  // transcript; the Summary + key points slots in above it a few seconds
  // later. Best-effort — a failed/timed-out summary just leaves the
  // transcript.
  void summarizeInBackground(slug, capture.bodyMarkdown, capture.videoId, capture.sourceUrl)

  return slug
}

async function summarizeInBackground(
  slug: string,
  transcript: string,
  videoId: string,
  sourceUrl: string,
): Promise<void> {
  try {
    const summary = await summarizeTranscript(transcript)
    if (!summary) return
    // Body = video URL (inline player) + summary + transcript, all in the
    // note. Linkify the whole thing so the summary's timestamps are
    // clickable too.
    const noteBody = linkifyTimestamps(
      `${sourceUrl}\n\n${withSummary(summary, transcript)}`,
      videoId,
    )
    await useDocsStore.getState().replaceDocBody(slug, noteBody)
  } catch (err) {
    console.warn('[youtube] background summarize failed', err)
  }
}

/** Fetch a YouTube URL's transcript + metadata and create the note in one
 *  step — the entry point a capture UI calls. Propagates the fetch error
 *  (no transcript, bad URL, YouTube changed the contract) so the caller
 *  can show a clean message. */
export async function captureYoutubeToNote(url: string): Promise<string | null> {
  const capture = await fetchYoutubeCapture(url)
  return createYoutubeNote(capture)
}

// Dev-only console handle, mirroring __scanVault. Lets the full pipeline
// (fetch → create → frontmatter flush) be exercised in the running app
// before the capture UI lands:
//   await __captureYoutube('https://www.youtube.com/watch?v=arj7oStGLkU')
// then check inbox/<title>.md exists with a frontmatter block, the note
// opens to the transcript (no raw YAML), and it survives a reload.
if (import.meta.env.DEV) {
  ;(window as unknown as { __captureYoutube: typeof captureYoutubeToNote }).__captureYoutube =
    captureYoutubeToNote
}
