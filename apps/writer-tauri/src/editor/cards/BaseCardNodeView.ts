// Shared base for block-level "card" NodeViews — image, video, and
// future audio / link / PDF cards. A card is a `contenteditable=false`
// atom whose body is rendered by the subclass; everything else (the
// outer wrapper, the WKWebView drag-preview workaround, the selected
// outline toggle, the mutation-observer opt-out) lives here once.
//
// The cards subdirectory is deliberately a thin abstraction: every
// concrete card type extends this class and supplies a body. There
// is no plugin / registry layer in between, because the only
// cross-card concern (auto-advancing the cursor after a drop) is
// handled at the editor level via cardDropAdvanceCursor.
//
// Drag entry is PM's natural path, not a custom handle:
//
//   - The schema's `atom: true` defaults `spec.draggable` to true,
//     so PM's MouseDown machinery arms `mightDrag` on a body
//     mousedown and momentarily flips `this.dom.draggable = true`.
//     PM's global dragstart handler then does NodeSelection +
//     serializeForClipboard + `view.dragging` setup — everything
//     the drop pipeline needs.
//   - We only attach a dragstart listener to swap the default browser
//     drag image for a canvas snapshot, scoped to the media alone so
//     WKWebView's preview doesn't bleed in surrounding compositor
//     layers. Listener order: figure (ours) bubbles to contentDOM
//     (PM's), so we fire first and setDragImage doesn't conflict
//     with PM's later setData calls.
//
// The earlier invisible handle + manual drag pipeline was a workaround
// for native `<video controls>` shadow DOM events that mightDrag was
// hijacking. With custom video controls (see VideoControls.ts) those
// internal events are stopPropagation'd locally, so the natural PM
// path is safe to use and the handle is dead code.
//
// What subclasses own:
//
//   - `renderBody(node)` — build the inner DOM (img, video, …) and
//     return the root element. Called once from the subclass
//     constructor; the subclass then calls `mountBody(el)` to insert
//     it into the wrapper.
//   - `updateBody(node)` — react to PM `update(node)` calls; return
//     true when the subclass accepted the update.
//   - Optionally `dragPreviewSource()` — element to render into the
//     drag-preview canvas. Defaults to `bodyEl`. Override when chrome
//     around the visual (e.g. controls bar) shouldn't appear in the
//     drag image.
//
// Why not pass `cardType` / `nodeName` via abstract members: TS
// initialises subclass fields *after* `super()` returns, so the
// parent constructor can't read them. Passing them through the super
// call is the cleanest workaround.

import { TextSelection } from '@milkdown/kit/prose/state'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'

export abstract class BaseCardNodeView {
  readonly dom: HTMLElement
  /** Subclass-rendered body element. Assigned via `mountBody`, which
   * the subclass calls from its constructor once its own refs (img,
   * video, …) are in place. Asserted non-null in dragPreviewSource
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

  /** Intercept the dragstart purely to swap in a WKWebView-safe
   * canvas preview. PM's contentDOM-level dragstart handler will
   * still run after us (bubble order) and take care of NodeSelection,
   * serializeForClipboard, dataTransfer payload, and `view.dragging`
   * — none of which conflict with our setDragImage call here. */
  private onDragStart = (e: DragEvent): void => {
    if (!e.dataTransfer) return
    const preview = this.buildDragPreview()
    if (!preview) return
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

  /** Cleanup after drag ends (whether a drop happened or the user
   * cancelled mid-drag). Two responsibilities:
   *   1. Remove the off-DOM preview if rAF hasn't.
   *   2. Collapse the selection to right after the card so the
   *      *next* mousedown anywhere inside the body doesn't satisfy
   *      PM's mightDrag "NodeSelection over targetPos" branch and
   *      re-arm the drag trap. Successful drops are already handled
   *      by cardDropAdvanceCursor (uiEvent === 'drop'); this path
   *      covers cancelled drags where no drop transaction runs. */
  private onDragEnd = (): void => {
    if (this.dragPreview) {
      this.dragPreview.remove()
      this.dragPreview = null
    }
    const pos = this.getPos()
    if (pos == null) return
    const { state } = this.view
    const node = state.doc.nodeAt(pos)
    if (!node) return
    const after = state.doc.resolve(pos + node.nodeSize)
    this.view.dispatch(
      state.tr.setSelection(TextSelection.near(after, 1)),
    )
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

  /** PM calls destroy() when the node is removed (delete, drop-move,
   * doc swap). Detach our dragstart/dragend listeners and clean up
   * any stray preview element. */
  destroy(): void {
    this.dom.removeEventListener('dragstart', this.onDragStart)
    this.dom.removeEventListener('dragend', this.onDragEnd)
    if (this.dragPreview) {
      this.dragPreview.remove()
      this.dragPreview = null
    }
  }
}
