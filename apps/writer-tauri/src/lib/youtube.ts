// YouTube transcript capture.
//
// Turns a YouTube URL into a normalised capture: title/author metadata +
// the transcript as timestamped markdown. The transcript itself is pulled
// by the `youtube-transcript` library, which uses YouTube's ANDROID
// InnerTube client — the one caption path that still works without a POT
// token (the plain WEB `api/timedtext` baseUrl now returns an empty body).
// See .context/yt-spike.mjs for the standalone proof and the memory note
// for why the WEB path is dead.
//
// Two structural choices:
//   - Transport goes through the Rust `fetch_http` command, not the
//     WebView's `fetch`: youtube.com is cross-origin and would be blocked
//     by CORS in the WebView. The library accepts an injected `fetch`, so
//     we hand it a thin shim over the Tauri command. The same shim fetches
//     oembed metadata.
//   - Metadata (title/author/thumbnail) comes from YouTube's *official*
//     `oembed` endpoint — stable, unlike the InnerTube internals — and
//     duration is approximated from the last transcript timestamp. This
//     keeps the fragile, likely-to-break surface confined to the
//     maintained library (recoverable with a dependency bump).

import { YoutubeTranscript } from 'youtube-transcript'
import { invoke } from '@tauri-apps/api/core'

/** A single timed line as returned by `youtube-transcript`: `offset` and
 *  `duration` are milliseconds, `text` is the caption text. */
export interface TranscriptSegment {
  text: string
  offset: number
  duration?: number
}

export interface YoutubeCapture {
  videoId: string
  sourceUrl: string
  title: string
  author?: string
  thumbnailUrl?: string
  /** Whole-video length in seconds, approximated from the transcript. */
  durationSec?: number
  /** Transcript rendered as timestamped markdown (the note body). */
  bodyMarkdown: string
}

/** Minimal `fetch`-compatible response. Both the `youtube-transcript`
 *  library and our oembed call only touch these three members, so the
 *  Tauri shim and a real `fetch` are interchangeable. */
export interface FetchLike {
  (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<{
    ok: boolean
    status: number
    json: () => Promise<unknown>
    text: () => Promise<string>
  }>
}

// ── pure helpers ──────────────────────────────────────────────────────

/** Extract the 11-char video id from any common YouTube URL form (watch,
 *  youtu.be, shorts, embed) or a bare id. Returns null if none found. */
export function parseYoutubeId(input: string): string | null {
  const trimmed = input.trim()
  if (/^[\w-]{11}$/.test(trimmed)) return trimmed
  let u: URL
  try {
    u = new URL(trimmed)
  } catch {
    return null
  }
  const host = u.hostname.replace(/^www\./, '')
  if (host === 'youtu.be') return idOrNull(u.pathname.slice(1))
  if (host === 'youtube.com' || host === 'm.youtube.com') {
    if (u.pathname === '/watch') return idOrNull(u.searchParams.get('v') ?? '')
    const m = u.pathname.match(/^\/(?:shorts|embed|v)\/([\w-]{11})/)
    if (m) return m[1]
  }
  return null
}

function idOrNull(s: string): string | null {
  return /^[\w-]{11}$/.test(s) ? s : null
}

function formatTimestamp(totalSec: number): string {
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = Math.floor(totalSec % 60)
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&#39;': "'",
  '&quot;': '"',
  '&nbsp;': ' ',
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;|&lt;|&gt;|&#39;|&quot;|&nbsp;/g, (m) => ENTITIES[m])
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
}

/** Render transcript segments as readable markdown: caption text grouped
 *  into ~`windowSec`-second windows, each line prefixed with a `[mm:ss]`
 *  timestamp. Empty/whitespace segments are dropped. Returns '' for an
 *  empty transcript. */
export function transcriptToMarkdown(
  segments: TranscriptSegment[],
  windowSec = 30,
): string {
  const lines: string[] = []
  let windowStart: number | null = null
  let buf: string[] = []

  const flush = () => {
    if (windowStart === null || buf.length === 0) return
    lines.push(`[${formatTimestamp(windowStart)}] ${buf.join(' ')}`)
    buf = []
  }

  for (const seg of segments) {
    const text = decodeEntities(seg.text).replace(/\s+/g, ' ').trim()
    if (!text) continue
    const sec = seg.offset / 1000
    if (windowStart === null) windowStart = sec
    if (sec - windowStart >= windowSec) {
      flush()
      windowStart = sec
    }
    buf.push(text)
  }
  flush()
  return lines.join('\n\n')
}

/** Convert bare `[mm:ss]` / `[h:mm:ss]` timestamps in markdown into
 *  deep-links that jump to that moment in the video. Timestamps already
 *  written as links (followed by `(`) are left alone, so re-running is
 *  idempotent. Pure — applied to the final note body so both the
 *  transcript and the LLM summary's timestamps become clickable; a
 *  ⌘/Ctrl-click opens them in the browser (linkClickPlugin). */
export function linkifyTimestamps(markdown: string, videoId: string): string {
  return markdown.replace(
    /\[(\d{1,2}:\d{2}(?::\d{2})?)\](?!\()/g,
    (_match, ts: string) => {
      const seconds = ts
        .split(':')
        .reduce((acc, part) => acc * 60 + Number(part), 0)
      return `[${ts}](https://www.youtube.com/watch?v=${videoId}&t=${seconds}s)`
    },
  )
}

/** Parse a timestamp deep-link (as emitted by {@link linkifyTimestamps})
 *  back into its video id + seconds, so a click handler can seek the
 *  embedded player instead of opening the browser. Returns null for any
 *  URL that isn't one of our `watch?v=…&t=…s` links. */
export function parseYoutubeTimestampLink(
  href: string,
): { videoId: string; sec: number } | null {
  let u: URL
  try {
    u = new URL(href)
  } catch {
    return null
  }
  if (u.hostname.replace(/^www\./, '') !== 'youtube.com') return null
  if (u.pathname !== '/watch') return null
  const videoId = u.searchParams.get('v')
  const t = u.searchParams.get('t')
  if (!videoId || !t) return null
  const sec = parseInt(t, 10) // "125s" → 125
  if (!Number.isFinite(sec)) return null
  return { videoId, sec }
}

/** Approximate the video length from the last segment's end time (offset
 *  + duration), in whole seconds. Undefined for an empty transcript. */
export function approxDurationSec(
  segments: TranscriptSegment[],
): number | undefined {
  if (segments.length === 0) return undefined
  const last = segments[segments.length - 1]
  return Math.round((last.offset + (last.duration ?? 0)) / 1000)
}

// ── IO ────────────────────────────────────────────────────────────────

/** `fetch`-shaped shim over the Rust `fetch_http` command, so library
 *  and oembed requests escape the WebView's CORS sandbox. */
export const tauriFetch: FetchLike = async (url, init = {}) => {
  const res = await invoke<{ status: number; body: string }>('fetch_http', {
    req: {
      method: init.method ?? 'GET',
      url,
      headers: init.headers ?? {},
      body: init.body ?? null,
    },
  })
  return {
    ok: res.status >= 200 && res.status < 300,
    status: res.status,
    json: async () => JSON.parse(res.body),
    text: async () => res.body,
  }
}

async function fetchOembed(
  videoId: string,
  fetchImpl: FetchLike,
): Promise<{ title?: string; author?: string; thumbnailUrl?: string }> {
  try {
    const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(
      `https://www.youtube.com/watch?v=${videoId}`,
    )}&format=json`
    const res = await fetchImpl(url)
    if (!res.ok) return {}
    const data = (await res.json()) as {
      title?: string
      author_name?: string
      thumbnail_url?: string
    }
    return {
      title: data.title,
      author: data.author_name,
      thumbnailUrl: data.thumbnail_url,
    }
  } catch {
    // oembed is best-effort metadata; a failure must not sink the capture.
    return {}
  }
}

/** Fetch a YouTube video's transcript + metadata and assemble a
 *  normalised capture. `fetchImpl` is injectable so a Node harness can
 *  pass the global `fetch`; the app uses the Tauri shim by default.
 *
 *  Throws if the URL has no video id or the transcript can't be
 *  retrieved (disabled captions, unavailable video, or YouTube changing
 *  the InnerTube contract). Callers surface a clean "no transcript"
 *  message rather than letting the raw error reach the user. */
export async function fetchYoutubeCapture(
  url: string,
  fetchImpl: FetchLike = tauriFetch,
): Promise<YoutubeCapture> {
  const videoId = parseYoutubeId(url)
  if (!videoId) throw new Error('not a recognisable YouTube URL')

  // Prefer an English track; fall back to whatever the video offers.
  let raw: TranscriptSegment[]
  try {
    raw = (await YoutubeTranscript.fetchTranscript(videoId, {
      lang: 'en',
      fetch: fetchImpl as unknown as typeof fetch,
    })) as TranscriptSegment[]
  } catch {
    raw = (await YoutubeTranscript.fetchTranscript(videoId, {
      fetch: fetchImpl as unknown as typeof fetch,
    })) as TranscriptSegment[]
  }
  if (!raw || raw.length === 0) throw new Error('no transcript available')

  const meta = await fetchOembed(videoId, fetchImpl)
  return {
    videoId,
    sourceUrl: `https://www.youtube.com/watch?v=${videoId}`,
    title: meta.title?.trim() || `YouTube ${videoId}`,
    author: meta.author,
    thumbnailUrl: meta.thumbnailUrl,
    durationSec: approxDurationSec(raw),
    bodyMarkdown: transcriptToMarkdown(raw),
  }
}
