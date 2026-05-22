// Shared base for block-level "card" NodeViews — image, and (Phase 2b)
// audio / video / link cards. A card is a `contenteditable=false`
// atom that owns its own drag entry, its own drag preview, and its
// own selection affordance, so each new media type only has to
// describe its body — the chrome and the WKWebView workarounds live
// here once.
//
// The cards subdirectory is deliberately a thin abstraction: every
// concrete card type extends this class and supplies a body. There
// is no plugin / registry layer in between, because the only
// cross-card concern (auto-advancing the cursor after a drop) is
// handled at the editor level via cardDropAdvanceCursor.
//
// What this class owns:
//
//   - The outer `<figure data-card="<type>" contenteditable=false
//     draggable=true>` wrapper, including the `.{type}-card` CSS hook.
//   - dragstart → explicit NodeSelection on this card (PM's native
//     handler would do it for clicks resolving inside the node, but
//     atoms have no resolvable interior — we set it ourselves).
//   - Canvas-based drag preview pinned at `z-index:-9999` inside the
//     viewport. A detached / off-viewport clone is silently ignored
//     by WKWebView (WebKit bugs #188490, #173856), so the preview
//     element must be in active layout.
//   - dragend cleanup safety net for the preview.
//   - `.ProseMirror-selectednode` toggle on selectNode/deselectNode —
//     PM's automatic toggle has historically been unreliable on
//     contenteditable=false wrappers.
//   - `ignoreMutation: () => true` — internal class toggles must not
//     bubble into PM's mutation observer.
//
// What subclasses own:
//
//   - `renderBody(node)` — build the inner DOM (img, audio, video,
//     thumbnail+title, …) and return the root element. Called once
//     from the subclass constructor; the subclass then calls
//     `mountBody(el)` to insert it into the wrapper.
//   - `updateBody(node)` — react to PM `update(node)` calls; return
//     true when the subclass accepted the update.
//   - Optionally `dragPreviewSource()` — element to render into the
//     drag-preview canvas. Defaults to `bodyEl`. Audio cards may
//     want to override to a thumbnail/icon instead of the full
//     player chrome.
//
// Why not pass `cardType` / `nodeName` via abstract members: TS
// initialises subclass fields *after* `super()` returns, so the
// parent constructor can't read them. Passing them through the super
// call is the cleanest workaround.

import { NodeSelection } from '@milkdown/kit/prose/state'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'

export abstract class BaseCardNodeView {
  readonly dom: HTMLElement
  /** Subclass-rendered body element. Assigned via `mountBody`, which
   * the subclass calls from its constructor once its own refs (img,
   * audio, …) are in place. Asserted non-null in dragPreviewSource
   * because every concrete subclass calls mountBody synchronously
   * before any PM-visible interaction is possible. */
  protected bodyEl: HTMLElement | null = null
  protected dragPreview: HTMLElement | null = null

  constructor(
    private readonly cardType: string,
    private readonly nodeName: string,
    protected readonly view: EditorView,
    protected readonly getPos: () => number | undefined,
  ) {
    this.dom = document.createElement('figure')
    this.dom.setAttribute('data-card', cardType)
    this.dom.setAttribute('contenteditable', 'false')
    this.dom.draggable = true
    this.dom.tabIndex = -1
    this.dom.className = `${cardType}-card relative block`
    this.dom.addEventListener('dragstart', this.onDragStart)
    this.dom.addEventListener('dragend', this.onDragEnd)
  }

  /** Subclass calls this from its constructor once its body element
   * is built. Kept separate from the super() call so the subclass's
   * own refs (e.g. `this.img`) can be assigned before the body is
   * wired — needed for `dragPreviewSource()` to return them. */
  protected mountBody(body: HTMLElement): void {
    this.bodyEl = body
    this.dom.appendChild(body)
  }

  /** Build the visual content of the card. Implementations construct
   * (and retain refs to) their inner DOM, then call `mountBody`
   * once before returning from their constructor. */
  protected abstract renderBody(node: PMNode): HTMLElement

  /** React to a PM `update(node)` call. Return false to signal that
   * PM should re-render the node from scratch (matches PM's NodeView
   * contract). Subclasses typically return true after diffing attrs
   * onto their retained refs. */
  protected abstract updateBody(node: PMNode): boolean

  /** Element snapshotted into the canvas drag preview. Defaults to
   * the body root; subclasses with chrome around the visual (audio
   * with controls, video with a poster) can override to return the
   * thumbnail-only element. */
  protected dragPreviewSource(): HTMLElement {
    if (!this.bodyEl) {
      throw new Error(
        `[card:${this.cardType}] dragPreviewSource called before mountBody`,
      )
    }
    return this.bodyEl
  }

  private onDragStart = (e: DragEvent): void => {
    if (!e.dataTransfer) return
    const pos = this.getPos()
    if (pos == null) return

    // Explicit NodeSelection so PM's downstream serializeForClipboard
    // and `view.dragging` operate on this card. PM's native handler
    // sets this only when posAtCoords resolves cleanly inside the
    // node — atoms have no resolvable interior, so we set it here.
    const { state } = this.view
    this.view.dispatch(
      state.tr.setSelection(NodeSelection.create(state.doc, pos)),
    )

    const preview = this.buildDragPreview()
    if (preview) {
      const width = Number(preview.dataset.width) || 0
      const height = Number(preview.dataset.height) || 0
      const offsetX = Math.min(width / 2, 80)
      const offsetY = Math.min(height / 2, 60)
      e.dataTransfer.setDragImage(preview, offsetX, offsetY)
      this.dragPreview = preview
      requestAnimationFrame(() => {
        preview.remove()
        if (this.dragPreview === preview) this.dragPreview = null
      })
    }
  }

  /** Render the drag preview into a canvas (for img/video sources)
   * or a near-invisible clone (everything else, including drawImage
   * failures like asset-protocol CORS taint). Pinned inside the
   * viewport at z-index:-9999 because WKWebView ignores off-viewport
   * setDragImage targets. */
  private buildDragPreview(): HTMLElement | null {
    const source = this.dragPreviewSource()
    const rect = source.getBoundingClientRect()
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

    if (
      source instanceof HTMLImageElement ||
      source instanceof HTMLVideoElement
    ) {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = rect.width
        canvas.height = rect.height
        const ctx = canvas.getContext('2d')
        if (ctx) {
          ctx.drawImage(source, 0, 0, rect.width, rect.height)
          pin(canvas, rect.width, rect.height)
          return canvas
        }
      } catch (err) {
        // SecurityError on cross-origin sources (asset:// URLs that
        // the browser treats as cross-origin) — fall through to the
        // clone strategy.
        console.debug(
          `[card:${this.cardType}] canvas drag preview unavailable`,
          err,
        )
      }
    }

    const clone = source.cloneNode(true) as HTMLElement
    clone.style.opacity = '0.0001'
    pin(clone, rect.width, rect.height)
    return clone
  }

  private onDragEnd = (): void => {
    if (this.dragPreview) {
      this.dragPreview.remove()
      this.dragPreview = null
    }
  }

  update(node: PMNode): boolean {
    if (node.type.name !== this.nodeName) return false
    return this.updateBody(node)
  }

  selectNode(): void {
    this.dom.classList.add('ProseMirror-selectednode')
  }

  deselectNode(): void {
    this.dom.classList.remove('ProseMirror-selectednode')
  }

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
