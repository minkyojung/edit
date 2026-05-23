// Image card — the concrete BaseCardNodeView for the block-level
// `imageBlock` schema node. Owns the inner `<img>` element, its
// vault-relative src resolution, and the alt/title diff. The
// wrapper, drag entry, preview canvas, and selection chrome all
// live on BaseCardNodeView.
//
// The inner `<img>` keeps `data-block="true"` so the schema's
// `img[data-block="true"]` parseDOM rule matches when the card is
// copy/pasted — clipboard HTML is built from schema `toDOM`, not
// from this NodeView, so the data attribute must live on the img.
//
// Inline `image` nodes (commonmark images embedded inside flowing
// text) render through a separate, lightweight `imageInlineNodeView`
// — they share the vault-asset resolver but not the card chrome,
// because inline images must follow the text baseline.

import { $prose } from '@milkdown/kit/utils'
import { Plugin } from '@milkdown/kit/prose/state'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'
import { resolveVaultAssetSrc } from '../utils/resolveVaultAssetSrc'
import { BaseCardNodeView } from './BaseCardNodeView'

class ImageCardNodeView extends BaseCardNodeView {
  private readonly img: HTMLImageElement
  private lastSrc: string | undefined

  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined) {
    super('image', 'imageBlock', view, getPos)

    this.img = document.createElement('img')
    this.img.alt = (node.attrs.alt as string) ?? ''
    if (node.attrs.title) this.img.title = String(node.attrs.title)
    this.img.className = 'max-w-full h-auto rounded block'
    // `draggable=false` on the image so native image-drag (which would
    // bypass the wrapper's dragstart handler and reintroduce the
    // surrounding-compositor-layer leak) can't fire as a second entry.
    this.img.draggable = false
    this.img.setAttribute('data-block', 'true')
    void this.applySrc(node.attrs.src as string | undefined)

    this.mountBody(this.img)
  }

  protected renderBody(): HTMLElement {
    // Body is built in the constructor (so `this.img` is available
    // for dragPreviewSource immediately). Returning the same ref
    // here keeps BaseCardNodeView's contract well-formed.
    return this.img
  }

  protected updateBody(node: PMNode): boolean {
    this.img.alt = (node.attrs.alt as string) ?? ''
    if (node.attrs.title) this.img.title = String(node.attrs.title)
    else this.img.removeAttribute('title')
    void this.applySrc(node.attrs.src as string | undefined)
    return true
  }

  /** Canvas snapshot source is the bare img — body and source are
   * the same for an image card, but we declare this explicitly so
   * future chrome around the img (e.g., loading overlay) doesn't
   * end up in the drag preview. */
  protected override dragPreviewSource(): HTMLElement {
    return this.img
  }

  private async applySrc(rawSrc: string | undefined): Promise<void> {
    if (this.lastSrc === rawSrc) return
    this.lastSrc = rawSrc
    if (!rawSrc) {
      this.img.removeAttribute('src')
      return
    }
    try {
      const resolved = await resolveVaultAssetSrc(rawSrc)
      // Race check: another applySrc may have started while we
      // awaited the path join. Only apply if the src we resolved is
      // still the one we want.
      if (this.lastSrc !== rawSrc) return
      if (resolved === null) {
        this.img.removeAttribute('src')
      } else {
        this.img.src = resolved
      }
    } catch (err) {
      console.warn('[image-card] resolve failed', { rawSrc, err })
    }
  }
}

export const imageNodeView = $prose(
  () =>
    new Plugin({
      props: {
        nodeViews: {
          imageBlock: (node, view, getPos) =>
            new ImageCardNodeView(node, view, getPos),
        },
      },
    }),
)
