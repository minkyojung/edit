// Custom media controls — replaces the browser's built-in
// `<video controls>` / `<audio controls>` shadow DOM. The native
// chrome was the source of every drag-vs-controls conflict we hit:
// shadow DOM internals (scrubber thumb, volume slider) fire pointer
// events that PM's `mightDrag` trap interprets as card-drag intent,
// and there is no way to intercept those events from outside the
// shadow tree. By rendering our own controls layer in plain DOM,
// every interactive element is reachable from our own code — each
// one calls `stopPropagation()` so its events don't bubble into
// PM's input pipeline, leaving the rest of the card body free to
// receive the mousedown that initiates a card drag.
//
// Works on any `HTMLMediaElement` — `<video>` and `<audio>` share
// the same playback API (play, pause, currentTime, duration,
// volume, muted, etc.), so the same factory drives both card
// types. Per-variant container styling (auto-hide gradient on
// video, solid background on audio) is handled by the variant
// `className` the caller supplies. Inner element styles target
// the shared `[data-card-controls]` attribute selector in
// index.css so the button / seek bar / time display look the
// same regardless of media type.
//
// Returned `destroy()` removes every listener this module attached
// to the media element and to the controls' interactive elements;
// callers must invoke it on NodeView teardown.

// Inline SVG icon strings. We can't import @tabler/icons-react from
// a vanilla NodeView, but using the same Tabler-family glyph data
// keeps the visual language consistent with the rest of the app.
// `fill="currentColor"` / `stroke="currentColor"` lets CSS `color`
// drive the icon hue — same surface as text-color contracts elsewhere.
const ICON_ATTRS =
  'width="14" height="14" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
  'stroke-linejoin="round"'
const ICON_PLAY = `<svg ${ICON_ATTRS}><path d="M7 4v16l13-8z" fill="currentColor"/></svg>`
const ICON_PAUSE = `<svg ${ICON_ATTRS}><path d="M6 5v14M18 5v14"/></svg>`
const ICON_REPLAY = `<svg ${ICON_ATTRS}><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>`
const ICON_VOLUME_ON = `<svg ${ICON_ATTRS}><path d="M15 8a5 5 0 0 1 0 8"/><path d="M17.7 5a9 9 0 0 1 0 14"/><path d="M6 15H4a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h2l3.5-4.5A.8.8 0 0 1 11 5v14a.8.8 0 0 1-1.5.5L6 15"/></svg>`
const ICON_VOLUME_OFF = `<svg ${ICON_ATTRS}><path d="M6 15H4a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h2l3.5-4.5A.8.8 0 0 1 11 5v14a.8.8 0 0 1-1.5.5L6 15"/><path d="M16 10l4 4M20 10l-4 4"/></svg>`

/** mm:ss for clips < 1 hour, h:mm:ss otherwise. NaN / Infinity
 * (before metadata loads) renders as 0:00 so the layout doesn't
 * jump when duration resolves. */
function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = s.toString().padStart(2, '0')
  if (h > 0) {
    const mm = m.toString().padStart(2, '0')
    return `${h}:${mm}:${ss}`
  }
  return `${m}:${ss}`
}

function createIconButton(label: string, svg: string): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.tabIndex = -1
  btn.setAttribute('aria-label', label)
  btn.innerHTML = svg
  return btn
}

export interface MediaControlsOptions {
  /** Class added to the controls root in addition to the shared
   * `[data-card-controls]` attribute — caller decides which variant
   * styling applies (e.g. `'video-controls'` for the absolute-positioned
   * gradient overlay, `'audio-controls'` for the solid in-flow bar). */
  className?: string
}

export function createMediaControls(
  video: HTMLMediaElement,
  options: MediaControlsOptions = {},
): {
  el: HTMLElement
  destroy: () => void
} {
  const el = document.createElement('div')
  if (options.className) el.className = options.className
  el.setAttribute('data-card-controls', '')

  const playBtn = createIconButton('Play', ICON_PLAY)
  playBtn.classList.add('play-pause')

  // Hit-area wrapper. The wrapper is taller than the visual track so
  // grabs near (but not exactly on) the 4px line still register, while
  // the track stays a thin 4px line visually. Keeping the two
  // concerns in different elements avoids the background-clip trick
  // that turned out to be unreliable in WKWebView.
  const seekBar = document.createElement('div')
  seekBar.className = 'seek-bar'
  seekBar.setAttribute('role', 'slider')
  seekBar.setAttribute('aria-label', 'Seek')
  const seekTrack = document.createElement('div')
  seekTrack.className = 'seek-track'
  const seekFill = document.createElement('div')
  seekFill.className = 'seek-fill'
  const seekThumb = document.createElement('div')
  seekThumb.className = 'seek-thumb'
  seekTrack.append(seekFill, seekThumb)
  seekBar.append(seekTrack)

  const timeEl = document.createElement('span')
  timeEl.className = 'time'
  timeEl.textContent = '0:00 / 0:00'

  const volBtn = createIconButton('Mute', ICON_VOLUME_ON)
  volBtn.classList.add('volume')

  el.append(playBtn, seekBar, timeEl, volBtn)

  // ── UI updaters ──────────────────────────────────────────────

  const renderPlayState = (): void => {
    if (video.ended) {
      playBtn.innerHTML = ICON_REPLAY
      playBtn.setAttribute('aria-label', 'Replay')
    } else if (video.paused) {
      playBtn.innerHTML = ICON_PLAY
      playBtn.setAttribute('aria-label', 'Play')
    } else {
      playBtn.innerHTML = ICON_PAUSE
      playBtn.setAttribute('aria-label', 'Pause')
    }
    // `is-paused` doubles as the "controls stay visible" hint for the
    // auto-hide CSS: while playing, hover is the only thing that
    // brings the bar in; while paused or ended, the bar stays up so
    // the user always has a way back to play / replay / seek.
    el.classList.toggle('is-paused', video.paused || video.ended)
  }

  const renderProgress = (): void => {
    const dur = Number.isFinite(video.duration) ? video.duration : 0
    const ratio = dur > 0 ? Math.min(1, video.currentTime / dur) : 0
    const pct = `${ratio * 100}%`
    seekFill.style.width = pct
    seekThumb.style.left = pct
    timeEl.textContent = `${formatTime(video.currentTime)} / ${formatTime(dur)}`
  }

  const renderVolume = (): void => {
    if (video.muted || video.volume === 0) {
      volBtn.innerHTML = ICON_VOLUME_OFF
      volBtn.setAttribute('aria-label', 'Unmute')
    } else {
      volBtn.innerHTML = ICON_VOLUME_ON
      volBtn.setAttribute('aria-label', 'Mute')
    }
  }

  // Initial paint (in case the video already has metadata when we mount).
  renderPlayState()
  renderProgress()
  renderVolume()

  // ── Wire video → UI ──────────────────────────────────────────

  const videoListeners: Array<[string, EventListener]> = [
    ['play', renderPlayState],
    ['pause', renderPlayState],
    ['ended', renderPlayState],
    ['timeupdate', renderProgress],
    ['loadedmetadata', renderProgress],
    ['durationchange', renderProgress],
    ['volumechange', renderVolume],
  ]
  for (const [type, fn] of videoListeners) {
    video.addEventListener(type, fn)
  }

  // ── Wire UI → video ──────────────────────────────────────────
  //
  // Each interactive element stops propagation so its click /
  // pointerdown can't bubble up to PM's input pipeline and trigger
  // the mightDrag trap that would start a card-move gesture. The
  // outer `<figure>` is still the drag origin for areas *not*
  // covered by these elements — that's how single-gesture card
  // drag survives this refactor.

  const onPlayClick = (e: MouseEvent): void => {
    e.stopPropagation()
    if (video.ended) {
      video.currentTime = 0
      void video.play()
    } else if (video.paused) {
      void video.play()
    } else {
      video.pause()
    }
  }
  playBtn.addEventListener('click', onPlayClick)

  // Stop the mousedown on the play button before PM ever sees it so
  // mightDrag isn't armed for the surrounding figure even on a
  // missed-click that doesn't end in a button click event.
  const stopMouseDown = (e: MouseEvent): void => {
    e.stopPropagation()
  }
  playBtn.addEventListener('mousedown', stopMouseDown)
  volBtn.addEventListener('mousedown', stopMouseDown)

  // Seek bar: pointer capture pattern so the user can drag past the
  // bar's boundaries and the seek keeps following the cursor — same
  // feel as YouTube / Substack scrubbers.

  const seekToClientX = (clientX: number): void => {
    const dur = Number.isFinite(video.duration) ? video.duration : 0
    if (dur <= 0) return
    const rect = seekBar.getBoundingClientRect()
    if (rect.width === 0) return
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    video.currentTime = ratio * dur
  }

  const onSeekPointerDown = (e: PointerEvent): void => {
    e.stopPropagation()
    e.preventDefault()
    seekBar.setPointerCapture(e.pointerId)
    seekToClientX(e.clientX)
  }
  const onSeekPointerMove = (e: PointerEvent): void => {
    if (!seekBar.hasPointerCapture(e.pointerId)) return
    seekToClientX(e.clientX)
  }
  const onSeekPointerUp = (e: PointerEvent): void => {
    if (seekBar.hasPointerCapture(e.pointerId)) {
      seekBar.releasePointerCapture(e.pointerId)
    }
  }
  seekBar.addEventListener('pointerdown', onSeekPointerDown)
  seekBar.addEventListener('pointermove', onSeekPointerMove)
  seekBar.addEventListener('pointerup', onSeekPointerUp)
  seekBar.addEventListener('pointercancel', onSeekPointerUp)

  const onVolClick = (e: MouseEvent): void => {
    e.stopPropagation()
    video.muted = !video.muted
  }
  volBtn.addEventListener('click', onVolClick)

  // ── Teardown ─────────────────────────────────────────────────

  const destroy = (): void => {
    for (const [type, fn] of videoListeners) {
      video.removeEventListener(type, fn)
    }
    playBtn.removeEventListener('click', onPlayClick)
    playBtn.removeEventListener('mousedown', stopMouseDown)
    volBtn.removeEventListener('mousedown', stopMouseDown)
    seekBar.removeEventListener('pointerdown', onSeekPointerDown)
    seekBar.removeEventListener('pointermove', onSeekPointerMove)
    seekBar.removeEventListener('pointerup', onSeekPointerUp)
    seekBar.removeEventListener('pointercancel', onSeekPointerUp)
    volBtn.removeEventListener('click', onVolClick)
  }

  return { el, destroy }
}
