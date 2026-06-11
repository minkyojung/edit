// Reader lead for a captured YouTube note (type 'youtube'). Composes the
// video's metadata (already on the KnownDoc / frontmatter) into a
// magazine-style lead: source → title → dek (the TL;DR) → byline → the
// video as the hero. None of it lives in the editable body; the body
// below holds the key points + transcript.

import { useRef } from 'react'
import type { KnownDoc } from '@/state/docsStore'
import { useObservePageTitle } from '@/hooks/useObservePageTitle'
import { YoutubeEmbed } from './YoutubeEmbed'

/** Whole seconds → `m:ss` (or `h:mm:ss` past an hour). */
function formatDuration(totalSec: number): string {
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const ss = String(Math.floor(totalSec % 60)).padStart(2, '0')
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`
  return `${m}:${ss}`
}

/** ISO timestamp → "January 3, 2023". Empty string when absent/invalid. */
function formatDate(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

export function YoutubeHeader({ known }: { known: KnownDoc }) {
  const ref = useRef<HTMLDivElement | null>(null)
  useObservePageTitle(ref)

  const duration =
    typeof known.durationSec === 'number' ? formatDuration(known.durationSec) : ''
  const byline = [duration, formatDate(known.createdAt ?? known.savedAt)]
    .filter(Boolean)
    .join(' · ')

  return (
    <div ref={ref} className="mb-6 w-full" aria-label="YouTube video">
      {known.siteName && (
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {known.siteName}
        </p>
      )}

      <h1 className="mt-2 text-3xl font-semibold leading-tight text-foreground">
        {known.title ?? 'Untitled'}
      </h1>

      {known.description && (
        <p className="mt-3 text-lg leading-relaxed text-muted-foreground">
          {known.description}
        </p>
      )}

      {byline && (
        <p className="mt-4 text-sm text-muted-foreground">{byline}</p>
      )}

      {known.videoId && (
        <>
          <hr className="mt-5 border-border" />
          <div className="mt-5">
            <YoutubeEmbed videoId={known.videoId} thumbnailUrl={known.thumbnailUrl} />
          </div>
        </>
      )}
    </div>
  )
}
