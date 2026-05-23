// Lightweight NodeView for the inline `image` node (the commonmark
// default — markdown `![alt](src)` embedded inside a paragraph). No
// card chrome, no drag handle: an inline image is meant to flow with
// surrounding text, so wrapping it in a block-level figure would
// break the text model.
//
// The companion `imageBlock` node (its own line) renders through
// `cards/ImageCardNodeView.ts`'s card NodeView, which adds the
// wrapper + drag preview scoping needed to keep WKWebView from
// compositing surrounding UI layers into the drag image.
//
// Right-click and drag-preview customisation intentionally don't live
// here — the alt-description dialog and the drag-scoping bug only
// apply when the image is its own block.

import { $prose } from '@milkdown/kit/utils'
import { Plugin } from '@milkdown/kit/prose/state'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { resolveVaultAssetSrc } from './utils/resolveVaultAssetSrc'

class ImageInlineNodeView {
  readonly dom: HTMLImageElement
  private lastSrc: string | undefined

  constructor(node: PMNode) {
    this.dom = document.createElement('img')
    this.dom.alt = (node.attrs.alt as string) ?? ''
    if (node.attrs.title) this.dom.title = String(node.attrs.title)
    this.dom.className = 'inline-block max-w-full h-auto rounded'
    void this.applySrc(node.attrs.src as string | undefined)
  }

  private async applySrc(rawSrc: string | undefined): Promise<void> {
    if (this.lastSrc === rawSrc) return
    this.lastSrc = rawSrc
    if (!rawSrc) {
      this.dom.removeAttribute('src')
      return
    }
    try {
      const resolved = await resolveVaultAssetSrc(rawSrc)
      // Race check: another applySrc may have started while we awaited
      // the path join. Only apply if the src we resolved is still the
      // one we want.
      if (this.lastSrc !== rawSrc) return
      if (resolved === null) {
        this.dom.removeAttribute('src')
      } else {
        this.dom.src = resolved
      }
    } catch (err) {
      console.warn('[image-inline-node-view] resolve failed', { rawSrc, err })
    }
  }

  update(node: PMNode): boolean {
    if (node.type.name !== 'image') return false
    this.dom.alt = (node.attrs.alt as string) ?? ''
    if (node.attrs.title) this.dom.title = String(node.attrs.title)
    else this.dom.removeAttribute('title')
    void this.applySrc(node.attrs.src as string | undefined)
    return true
  }
}

export const imageInlineNodeView = $prose(
  () =>
    new Plugin({
      props: {
        nodeViews: {
          image: (node) => new ImageInlineNodeView(node),
        },
      },
    }),
)
