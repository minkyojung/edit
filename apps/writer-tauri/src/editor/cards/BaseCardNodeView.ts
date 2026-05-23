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

import { NodeSelection, TextSelection } from '@milkdown/kit/prose/state'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'

export abstract class BaseCardNodeView {
  readonly dom: HTMLElement
  /** Drag handle button pinned in the card's left gutter. Owns the
   * native dragstart entry so the card body itself can stay
   * non-draggable — important for media with internal controls
   * (`<video controls>` seek/volume sliders, future audio scrubber)
   * where wrapper-level drag would intercept the user's pointer
   * before the native control could receive it. */
  protected readonly handle: HTMLButtonElement
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
    // The wrapper stays at the HTML default (`draggable=false`). PM
    // would otherwise force it true when the schema declares
    // `draggable: true` — but the schemas opt out of that path
    // precisely so this wrapper can never become a drag origin. Drag
    // entry is owned end-to-end by the handle below.
    this.dom.tabIndex = -1
    this.dom.className = `${cardType}-card relative block`

    this.handle = document.createElement('button')
    this.handle.type = 'button'
    this.handle.draggable = true
    this.handle.tabIndex = -1
    this.handle.setAttribute('data-card-handle', '')
    this.handle.setAttribute('aria-label', 'Move this block')
    this.handle.textContent = '⋮⋮'
    this.handle.addEventListener('dragstart', this.onDragStart)
    this.handle.addEventListener('dragend', this.onDragEnd)
    this.handle.addEventListener('mousedown', this.onHandleMouseDown)
    this.dom.appendChild(this.handle)
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

  /** Drive the entire HTML5 dragstart manually. We do this instead of
   * relying on PM's schema-driven auto-drag because that path forces
   * `draggable="true"` onto the NodeView's outer DOM, which competes
   * with native `<video controls>` shadow DOM interactions and re-
   * introduces the WKWebView compositor leak on the surrounding card
   * chrome. Schemas opt out of PM's auto-drag (no `draggable: true`),
   * and the handle owns the full path:
   *
   *   1. Promote the cursor to a NodeSelection on this card so PM's
   *      drop logic and serializer have a well-formed selection to
   *      work from.
   *   2. Build the slice and run it through `view.serializeForClipboard`
   *      so clipboard handlers / external drop targets see exactly
   *      what PM's auto-drag would have produced.
   *   3. Set `view.dragging` so PM's stock drop handler recognises the
   *      incoming drop as an internal move (vs. an external paste) and
   *      deletes the source node when re-inserting at the drop point.
   *   4. Replace the default drag preview with a canvas snapshot — see
   *      `buildDragPreview` for the WKWebView-specific reasoning.
   *   5. Stop the event from bubbling so PM's contentDOM-level dragstart
   *      handler doesn't run a second pass on an already-prepared state. */
  private onDragStart = (e: DragEvent): void => {
    if (!e.dataTransfer) return
    const pos = this.getPos()
    if (pos == null) return

    const { state } = this.view
    const selection = NodeSelection.create(state.doc, pos)
    this.view.dispatch(state.tr.setSelection(selection))

    const slice = selection.content()
    const serialized = (
      this.view as unknown as {
        serializeForClipboard: (s: typeof slice) => {
          dom: HTMLElement
          text: string
        }
      }
    ).serializeForClipboard(slice)
    e.dataTransfer.setData('text/html', serialized.dom.innerHTML)
    e.dataTransfer.setData('text/plain', serialized.text)
    e.dataTransfer.effectAllowed = 'copyMove'

    // `view.dragging` is PM internal but stable — tiptap and most PM-
    // based editors rely on it the same way. The shape PM reads from
    // it: `{ slice, move }` (move=true ⇒ delete source on drop).
    ;(
      this.view as unknown as {
        dragging: { slice: typeof slice; move: boolean } | null
      }
    ).dragging = {
      slice,
      move: !(e.ctrlKey || e.metaKey),
    }

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

    e.stopPropagation()
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

  /** Suppress the cursor-positioning side effect of clicking the
   * handle. Without this, PM tries to place a text caret near the
   * handle's coordinates and the click flickers the doc selection
   * before the dragstart kicks in. */
  private onHandleMouseDown = (e: MouseEvent): void => {
    e.preventDefault()
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


  /** PM mounts NodeViews into the editor via direct DOM ops; when a
   * card is removed (delete, drop-move, doc swap) PM calls destroy().
   * Detach the handle listeners so the GC can reclaim. The figure and
   * body themselves carry no listeners now that PM owns the natural
   * mousedown → atom-selection / mightDrag path. */
  destroy(): void {
    this.handle.removeEventListener('dragstart', this.onDragStart)
    this.handle.removeEventListener('dragend', this.onDragEnd)
    this.handle.removeEventListener('mousedown', this.onHandleMouseDown)
    if (this.dragPreview) {
      this.dragPreview.remove()
      this.dragPreview = null
    }
  }
}
