// Video card — concrete BaseCardNodeView for the block-level
// `videoBlock` schema node. Owns the inner `<video>` element, its
// vault-relative src resolution, and a custom controls layer.
//
// Why custom controls instead of the browser's `<video controls>`:
// the built-in controls live in user-agent shadow DOM, so their
// internal interactive elements (scrubber thumb, volume slider) are
// out of reach of any event handler we can attach. PM's `mightDrag`
// trap then hijacks pointer events that originated in that shadow
// DOM and treats them as card-drag intent. Replacing the controls
// with our own plain-DOM elements (see VideoControls.ts) lets us
// attach `stopPropagation` to each interactive piece so PM never
// sees those clicks, while the rest of the video body remains a
// normal mousedown surface that PM can drive into a card drag.
//
// `resolveImageSrc` reuse — the helper is image-named but its
// implementation is generic (vault-relative path → `convertFileSrc`
// asset URL, with absolute URLs passing through). Renaming it
// `resolveVaultAssetSrc` is deferred to a separate cleanup PR.
//
// Inner `<video>` keeps `data-block="true"` so the schema's
// `video[data-block="true"]` parseDOM rule continues to match when
// the card is copy/pasted — clipboard HTML is built from schema
// `toDOM`, not from this NodeView.

import { $prose } from '@milkdown/kit/utils'
import { Plugin } from '@milkdown/kit/prose/state'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'
import { resolveImageSrc } from '../utils/resolveImageSrc'
import { BaseCardNodeView } from './BaseCardNodeView'
import { createVideoControls } from './VideoControls'

class VideoCardNodeView extends BaseCardNodeView {
  private readonly video: HTMLVideoElement
  private readonly controlsDestroy: () => void
  private lastSrc: string | undefined

  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined) {
    super('video', 'videoBlock', view, getPos)

    this.video = document.createElement('video')
    // Native UA controls are off — we render our own (see VideoControls).
    // The controls layer attaches stopPropagation per interactive
    // element, leaving the rest of the body free to receive the
    // mousedown that PM uses to start a card drag.
    this.video.controls = false
    if (node.attrs.title) this.video.title = String(node.attrs.title)
    this.video.className = 'max-w-full h-auto rounded block'
    this.video.draggable = false
    this.video.setAttribute('data-block', 'true')
    // Without native `<video controls>`, the browser doesn't bother
    // decoding the first frame on its own — the video paints as an
    // empty black box until the user hits play. To get a poster-like
    // first frame, we `preload="auto"` the file and nudge currentTime
    // by a hair as soon as metadata is in. Setting currentTime to a
    // small positive value (not 0, which would be a no-op against the
    // initial position) forces the decoder to seek-and-render that
    // frame. Local vault files make the preload="auto" cost negligible.
    this.video.preload = 'auto'
    this.video.addEventListener(
      'loadedmetadata',
      () => {
        // Use 0.001s rather than 0 so the seek registers as a change.
        // Skipping the nudge when the user has already started
        // playback (paused=false) avoids yanking them back to the
        // start on autoplay scenarios.
        if (this.video.paused && this.video.currentTime === 0) {
          this.video.currentTime = 0.001
        }
      },
      { once: true },
    )
    void this.applySrc(node.attrs.src as string | undefined)

    this.mountBody(this.video)

    const { el: controlsEl, destroy } = createVideoControls(this.video)
    this.controlsDestroy = destroy
    this.dom.appendChild(controlsEl)
  }

  protected renderBody(): HTMLElement {
    return this.video
  }

  protected updateBody(node: PMNode): boolean {
    if (node.attrs.title) this.video.title = String(node.attrs.title)
    else this.video.removeAttribute('title')
    void this.applySrc(node.attrs.src as string | undefined)
    return true
  }

  /** Canvas snapshot source is the bare video element. BaseCardNodeView's
   * buildDragPreview already accepts HTMLVideoElement in its drawImage
   * branch — the canvas captures the currently-rendered frame, which
   * matches what the user sees on the page. */
  protected override dragPreviewSource(): HTMLElement {
    return this.video
  }

  override destroy(): void {
    this.controlsDestroy()
    super.destroy()
  }

  private async applySrc(rawSrc: string | undefined): Promise<void> {
    if (this.lastSrc === rawSrc) return
    this.lastSrc = rawSrc
    if (!rawSrc) {
      this.video.removeAttribute('src')
      return
    }
    try {
      const resolved = await resolveImageSrc(rawSrc)
      if (this.lastSrc !== rawSrc) return
      if (resolved === null) {
        this.video.removeAttribute('src')
      } else {
        this.video.src = resolved
      }
    } catch (err) {
      console.warn('[video-card] resolve failed', { rawSrc, err })
    }
  }
}

export const videoNodeView = $prose(
  () =>
    new Plugin({
      props: {
        nodeViews: {
          videoBlock: (node, view, getPos) =>
            new VideoCardNodeView(node, view, getPos),
        },
      },
    }),
)
