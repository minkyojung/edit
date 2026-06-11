// Lite YouTube embed: shows the thumbnail with a play button and only
// swaps in the (privacy-friendly) youtube-nocookie iframe once the user
// clicks. Avoids loading YouTube's player until it's actually wanted, and
// keeps the heavy frame out of the first paint.
//
// `enablejsapi=1` is set so a later step can seek the player to a
// timestamp via postMessage. Requires the CSP `frame-src` opened to
// youtube(-nocookie).com (tauri.conf.json).

import { useEffect, useRef, useState } from 'react'
import { IconPlayerPlayFilled } from '@tabler/icons-react'
import { useYoutubePlayerStore } from '@/state/youtubePlayerStore'

/** Reliable thumbnail for the poster frame. Prefer the one captured from
 *  oembed; fall back to hqdefault, which every public video has. */
function posterUrl(videoId: string, thumbnailUrl?: string): string {
  return thumbnailUrl || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
}

export function YoutubeEmbed({
  videoId,
  thumbnailUrl,
}: {
  videoId: string
  thumbnailUrl?: string
}) {
  const [playing, setPlaying] = useState(false)
  const [startAt, setStartAt] = useState(0)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const pendingSeek = useYoutubePlayerStore((s) => s.pendingSeek)

  // A timestamp was clicked elsewhere: if we're already playing, seek the
  // live player via the IFrame API; otherwise start playing at that point.
  useEffect(() => {
    if (!pendingSeek || pendingSeek.videoId !== videoId) return
    if (playing && iframeRef.current?.contentWindow) {
      iframeRef.current.contentWindow.postMessage(
        JSON.stringify({ event: 'command', func: 'seekTo', args: [pendingSeek.sec, true] }),
        '*',
      )
    } else {
      setStartAt(pendingSeek.sec)
      setPlaying(true)
    }
  }, [pendingSeek, videoId, playing])

  if (playing) {
    return (
      <div className="aspect-video w-full overflow-hidden rounded-lg bg-black">
        <iframe
          ref={iframeRef}
          className="h-full w-full"
          src={`https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&enablejsapi=1&rel=0&start=${startAt}`}
          title="YouTube video player"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowFullScreen
        />
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={() => setPlaying(true)}
      aria-label="Play video"
      className="group relative aspect-video w-full overflow-hidden rounded-lg bg-black"
    >
      <img
        src={posterUrl(videoId, thumbnailUrl)}
        alt=""
        className="h-full w-full object-cover opacity-90 transition group-hover:opacity-100"
        onError={(e) => {
          e.currentTarget.style.visibility = 'hidden'
        }}
      />
      <span className="absolute inset-0 flex items-center justify-center">
        <span className="flex size-16 items-center justify-center rounded-full bg-black/70 text-white transition group-hover:bg-red-600">
          <IconPlayerPlayFilled className="size-7" />
        </span>
      </span>
    </button>
  )
}
