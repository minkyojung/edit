// Header card for a captured YouTube note (type 'youtube'). Renders the
// video's thumbnail + title + channel/duration + a "Watch on YouTube"
// link from the doc's metadata (already on the KnownDoc / frontmatter),
// so none of it lives in the editable body. Shown above the editor by
// PageHeader instead of the default editable-title input.

import { useRef } from 'react'
import { IconBrandYoutube } from '@tabler/icons-react'
import type { KnownDoc } from '@/state/docsStore'
import { useObservePageTitle } from '@/hooks/useObservePageTitle'
import { openLinkSafely } from '@/editor/linkUtils'
import { YoutubeEmbed } from './YoutubeEmbed'

/** Whole seconds → `m:ss` (or `h:mm:ss` past an hour). */
function formatDuration(totalSec: number): string {
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = Math.floor(totalSec % 60)
  const ss = String(s).padStart(2, '0')
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`
  return `${m}:${ss}`
}

export function YoutubeHeader({ known }: { known: KnownDoc }) {
  const ref = useRef<HTMLDivElement | null>(null)
  useObservePageTitle(ref)

  const duration =
    typeof known.durationSec === 'number'
      ? formatDuration(known.durationSec)
      : null
  const meta = [known.siteName, duration].filter(Boolean).join(' · ')

  return (
    <div ref={ref} className="mb-6 w-full" aria-label="YouTube video">
      <h1 className="text-2xl font-semibold leading-tight text-foreground">
        {known.title ?? 'Untitled'}
      </h1>
      <div className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
        {meta && <span>{meta}</span>}
        {known.sourceUrl && (
          <button
            type="button"
            onClick={() => openLinkSafely(known.sourceUrl!)}
            className="inline-flex items-center gap-1 transition-colors hover:text-foreground"
          >
            <IconBrandYoutube className="size-4 text-red-500" />
            YouTube
          </button>
        )}
      </div>
      {known.videoId && (
        <div className="mt-4">
          <YoutubeEmbed videoId={known.videoId} thumbnailUrl={known.thumbnailUrl} />
        </div>
      )}
    </div>
  )
}
