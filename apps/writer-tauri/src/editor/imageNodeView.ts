// Card NodeView for the block-level `imageBlock` node.
//
// The card wraps the image in a `contenteditable=false` figure so
// the text-editing flow can't land inside it (no caret drift onto
// the image, no accidental typing-over). The figure itself is the
// drag entry point — clicking and dragging anywhere on the card
// starts the drag.
//
// Drag preview: WKWebView's default `setDragImage(thisElement)`
// snapshot pulls in surrounding compositor layers (opacity-transitioned
// footer/chat chrome) because the source element shares a stacking
// context with them. To scope the preview to the image alone, we
// render a fresh canvas of the image and pass that canvas as the
// drag image. A canvas is its own compositor surface — it carries no
// neighbouring layers into the snapshot, regardless of what is
// promoted in the surrounding document.
//
// Why canvas (not an off-DOM clone): off-DOM / off-viewport clones
// are silently ignored by WKWebView's drag-image pipeline (WebKit
// bugs #188490, #173856 — the element must be in active layout for
// the snapshot to take it as authoritative). The canvas lives in
// the DOM but pinned behind everything via `z-index: -9999`, so it's
// in active layout but invisible to the user.
//
// The inner `<img>` keeps `data-block="true"` so the schema's
// `img[data-block="true"]` parseDOM rule continues to match when the
// card is copy/pasted: ProseMirror's clipboard serializer uses schema
// `toDOM`, not the NodeView, so external markdown round-trip is
// unaffected.
//
// Inline `image` nodes (commonmark default — image embedded inside a
// paragraph of text) render through `imageInlineNodeView.ts`. The two
// node types share `resolveImageSrc` for vault-relative path → asset
// URL translation, but only `imageBlock` gets the card chrome.

import { $prose } from '@milkdown/kit/utils'
import { NodeSelection, Plugin } from '@milkdown/kit/prose/state'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'
import { resolveImageSrc } from './utils/resolveImageSrc'

class ImageBlockNodeView {
  readonly dom: HTMLElement
  private readonly img: HTMLImageElement
  private lastSrc: string | undefined
  private dragPreview: HTMLElement | null = null
  private readonly view: EditorView
  private readonly getPos: () => number | undefined

  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined) {
    this.view = view
    this.getPos = getPos

    // Outer card wrapper. `contenteditable=false` removes it from the
    // text-editing flow so the caret never lands inside. `draggable=true`
    // makes the figure itself the drag entry point — clicking the card
    // and dragging starts a native dragstart, which we intercept below
    // to swap in our canvas-rendered preview.
    this.dom = document.createElement('figure')
    this.dom.setAttribute('data-card', 'image')
    this.dom.setAttribute('contenteditable', 'false')
    this.dom.draggable = true
    this.dom.tabIndex = -1
    this.dom.className = 'image-card relative block'

    // The image itself. `data-block="true"` keeps the schema's
    // parseDOM rule (`img[data-block="true"]`) matching when the card
    // is copied — clipboard HTML is built from schema `toDOM`, not
    // from this NodeView, so the data attribute must live on the img.
    // `draggable=false` on the image ensures the native image-drag
    // path (which would bypass our wrapper's dragstart handler) can't
    // fire as a separate entry.
    this.img = document.createElement('img')
    this.img.alt = (node.attrs.alt as string) ?? ''
    if (node.attrs.title) this.img.title = String(node.attrs.title)
    this.img.className = 'max-w-full h-auto rounded block'
    this.img.draggable = false
    this.img.setAttribute('data-block', 'true')
    void this.applySrc(node.attrs.src as string | undefined)

    this.dom.appendChild(this.img)

    this.dom.addEventListener('dragstart', this.onDragStart)
    this.dom.addEventListener('dragend', this.onDragEnd)
  }

  /** Pre-select this card before the drag starts so PM's downstream
   * logic (serializeForClipboard, `view.dragging`) operates on this
   * node. Then swap the drag preview to a canvas rendering of the
   * image so WKWebView's snapshot is scoped to the image alone. */
  private onDragStart = (e: DragEvent): void => {
    if (!e.dataTransfer) return
    const pos = this.getPos()
    if (pos == null) return

    // Make sure the dragged node is this card. PM's native dragstart
    // handler would do this, but only when `posAtCoords` resolves
    // cleanly inside the node — explicit set guarantees correctness.
    const { state } = this.view
    this.view.dispatch(
      state.tr.setSelection(NodeSelection.create(state.doc, pos)),
    )

    const preview = this.buildDragPreview()
    if (preview) {
      const { width, height } = preview.dataset
      const offsetX = Math.min((Number(width) || 0) / 2, 80)
      const offsetY = Math.min((Number(height) || 0) / 2, 60)
      e.dataTransfer.setDragImage(preview, offsetX, offsetY)
      this.dragPreview = preview
      // The browser captures the snapshot on the next paint. Remove
      // after that so the hidden preview doesn't linger.
      requestAnimationFrame(() => {
        preview.remove()
        if (this.dragPreview === preview) this.dragPreview = null
      })
    }
  }

  /** Render a canvas snapshot of the image and pin it behind everything
   * in the viewport. Canvas creates its own compositor layer, so
   * WKWebView's drag snapshot has no neighbouring layers to bleed in.
   * If `drawImage` fails (asset-protocol CORS taint, image not yet
   * loaded), we fall back to a near-invisible clone of the image
   * element pinned in the same way. */
  private buildDragPreview(): HTMLElement | null {
    const rect = this.img.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return null

    const pin = (el: HTMLElement, w: number, h: number) => {
      el.style.cssText =
        'position:fixed;top:0;left:0;' +
        `width:${w}px;height:${h}px;` +
        'pointer-events:none;z-index:-9999;'
      el.dataset.width = String(w)
      el.dataset.height = String(h)
      document.body.appendChild(el)
    }

    try {
      const canvas = document.createElement('canvas')
      canvas.width = rect.width
      canvas.height = rect.height
      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.drawImage(this.img, 0, 0, rect.width, rect.height)
        pin(canvas, rect.width, rect.height)
        return canvas
      }
    } catch (err) {
      // SecurityError on asset:// URLs that the browser deems
      // cross-origin. Fall through to the visible-clone strategy.
      console.debug('[image-card] canvas drag preview unavailable', err)
    }

    const clone = this.img.cloneNode(true) as HTMLImageElement
    clone.style.opacity = '0.0001'
    pin(clone, rect.width, rect.height)
    return clone
  }

  /** Safety net for preview removal — if the drag is cancelled or
   * short-circuited before the next paint, rAF cleanup may not run
   * (browsers can suppress rAF for cancelled drags). */
  private onDragEnd = (): void => {
    if (this.dragPreview) {
      this.dragPreview.remove()
      this.dragPreview = null
    }
  }

  private async applySrc(rawSrc: string | undefined): Promise<void> {
    if (this.lastSrc === rawSrc) return
    this.lastSrc = rawSrc
    if (!rawSrc) {
      this.img.removeAttribute('src')
      return
    }
    try {
      const resolved = await resolveImageSrc(rawSrc)
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
      console.warn('[image-card-node-view] resolve failed', { rawSrc, err })
    }
  }

  update(node: PMNode): boolean {
    if (node.type.name !== 'imageBlock') return false
    this.img.alt = (node.attrs.alt as string) ?? ''
    if (node.attrs.title) this.img.title = String(node.attrs.title)
    else this.img.removeAttribute('title')
    void this.applySrc(node.attrs.src as string | undefined)
    return true
  }

  /** Toggle the standard PM selected-node class on the outer card.
   * PM applies this class automatically for many NodeView shapes, but
   * `contenteditable=false` wrappers have historically been a known
   * gap — making the toggle explicit keeps the selected ring reliable. */
  selectNode(): void {
    this.dom.classList.add('ProseMirror-selectednode')
  }

  deselectNode(): void {
    this.dom.classList.remove('ProseMirror-selectednode')
  }

  /** Any presentation-only DOM change inside the card (e.g. selected
   * overlay class toggle) must not feed back into PM's mutation
   * observer, which would otherwise dispatch a no-op transaction. */
  ignoreMutation(): boolean {
    return true
  }

  destroy(): void {
    this.dom.removeEventListener('dragstart', this.onDragStart)
    this.dom.removeEventListener('dragend', this.onDragEnd)
    if (this.dragPreview) {
      this.dragPreview.remove()
      this.dragPreview = null
    }
  }
}

export const imageNodeView = $prose(
  () =>
    new Plugin({
      props: {
        nodeViews: {
          imageBlock: (node, view, getPos) =>
            new ImageBlockNodeView(node, view, getPos),
        },
      },
    }),
)
