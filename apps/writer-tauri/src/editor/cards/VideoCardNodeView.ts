// Video card — concrete BaseCardNodeView for the block-level
// `videoBlock` schema node. Owns the inner `<video controls>`
// element and the vault-relative src → asset URL resolution. The
// wrapper, drag entry, canvas preview, and selection chrome all
// live on BaseCardNodeView, identical to the image card.
//
// `resolveImageSrc` reuse — the helper is image-named but its
// implementation is generic (vault-relative path → `convertFileSrc`
// asset URL, with absolute URLs passing through). Renaming it
// `resolveVaultAssetSrc` is deferred to a separate cleanup PR so
// this feature stays focused on the new card type.
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

class VideoCardNodeView extends BaseCardNodeView {
  private readonly video: HTMLVideoElement
  private lastSrc: string | undefined

  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined) {
    super('video', 'videoBlock', view, getPos)

    this.video = document.createElement('video')
    this.video.controls = true
    if (node.attrs.title) this.video.title = String(node.attrs.title)
    this.video.className = 'max-w-full h-auto rounded block'
    // `draggable=false` on the video so native media-drag (which would
    // bypass the wrapper's dragstart handler) can't fire as a second
    // entry. The wrapper figure owns the drag entry exclusively.
    this.video.draggable = false
    this.video.setAttribute('data-block', 'true')
    // Preload metadata only so the first frame can render as a poster
    // without paying for the full file download up front. Users can
    // hit play to fetch the rest.
    this.video.preload = 'metadata'
    void this.applySrc(node.attrs.src as string | undefined)

    this.mountBody(this.video)
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

  private async applySrc(rawSrc: string | undefined): Promise<void> {
    if (this.lastSrc === rawSrc) return
    this.lastSrc = rawSrc
    if (!rawSrc) {
      this.video.removeAttribute('src')
      return
    }
    try {
      const resolved = await resolveImageSrc(rawSrc)
      // Race check: another applySrc may have started while we awaited
      // the path join. Only apply if the src we resolved is still the
      // one we want.
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
