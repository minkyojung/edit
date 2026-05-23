// Audio card — concrete BaseCardNodeView for the block-level
// `audioBlock` schema node. Layout:
//
//   ┌──────────────────────────────────┐
//   │ [Add a description…]            │ ← title input
//   ├──────────────────────────────────┤
//   │ ▶  ●━━━━●━━━━  00:23 / 03:45 🔊 │ ← MediaControls
//   └──────────────────────────────────┘
//
// The title input is what makes the audio card "identifiable" — an
// audio file has no visual frame, so the user-supplied description
// stands in for the poster image a video card would show. The text
// is persisted to the markdown's `<audio title="…">` attribute so
// external readers see what the clip is about even without playback.
//
// Why an `<input>` for the title and not a contenteditable region:
// PM's contentDOM model doesn't support editable interiors on atom
// nodes. A plain HTML input is its own focus / selection surface;
// PM treats clicks on it the same way it treats clicks on any
// `contenteditable=false` child. Keyboard events on the input are
// `stopPropagation`'d so PM's keymap doesn't intercept typing
// (default would be to replace the selected atom).
//
// The actual playback element (`<audio>`) is hidden — MediaControls
// is the only player UI. Drag preview for an audio card has no
// useful visual; BaseCardNodeView's fallback path (cloned body with
// near-zero opacity) keeps the drag pointer-feedback minimal.

import { $prose } from '@milkdown/kit/utils'
import { Plugin } from '@milkdown/kit/prose/state'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'
import { resolveVaultAssetSrc } from '../utils/resolveVaultAssetSrc'
import { BaseCardNodeView } from './BaseCardNodeView'
import { createMediaControls } from './MediaControls'

class AudioCardNodeView extends BaseCardNodeView {
  private readonly audio: HTMLAudioElement
  private readonly titleInput: HTMLInputElement
  private readonly titleHost: HTMLDivElement
  private readonly controlsDestroy: () => void
  private lastSrc: string | undefined
  private lastTitle: string | undefined

  constructor(
    node: PMNode,
    view: EditorView,
    getPos: () => number | undefined,
  ) {
    super('audio', 'audioBlock', view, getPos)

    // Title input — primary identifier for an audio card. Always
    // editable; changes commit to node.attrs.title on every input
    // event so the markdown reflects user intent without an explicit
    // save action.
    this.titleInput = document.createElement('input')
    this.titleInput.type = 'text'
    this.titleInput.className = 'audio-title-input'
    this.titleInput.placeholder = 'Add a description'
    this.titleInput.value = (node.attrs.title as string) ?? ''
    this.titleInput.spellcheck = false
    this.lastTitle = this.titleInput.value

    // WebKit refuses to commit text into an `<input>` whose nearest
    // contenteditable ancestor is `false` — a quirk that breaks our
    // atom card (BaseCardNodeView sets contenteditable=false on the
    // figure for selection isolation). The workaround is a small
    // contenteditable=true wrapper just around the input, restoring
    // WebKit's input editing without affecting PM: PM treats the
    // node as an atom and doesn't traverse inside the NodeView, so
    // a deeper contenteditable=true element is invisible to PM's
    // selection model. Tiptap / Lexical wrap their React-mounted
    // editable atoms the same way internally.
    this.titleHost = document.createElement('div')
    this.titleHost.className = 'audio-title-host'
    this.titleHost.setAttribute('contenteditable', 'true')
    this.titleHost.appendChild(this.titleInput)

    // Stop keyboard events from reaching PM's keymap. PM would
    // otherwise see typing-against-an-atom and try to replace the
    // node with the typed character.
    const stopKey = (e: Event) => e.stopPropagation()
    this.titleInput.addEventListener('keydown', stopKey)
    this.titleInput.addEventListener('keyup', stopKey)
    this.titleInput.addEventListener('keypress', stopKey)
    this.titleInput.addEventListener('beforeinput', stopKey)

    // Commit input → node attrs. We use setNodeMarkup so PM treats it
    // as a normal attr update, not a content edit — Yjs sync, undo
    // grouping, etc. all behave correctly.
    this.titleInput.addEventListener('input', this.onTitleInput)

    // Audio playback element — hidden, controls layer handles all UI.
    this.audio = document.createElement('audio')
    this.audio.controls = false
    this.audio.preload = 'metadata'
    this.audio.setAttribute('data-block', 'true')
    void this.applySrc(node.attrs.src as string | undefined)

    const body = document.createElement('div')
    body.className = 'audio-card-body'
    body.append(this.titleHost, this.audio)
    this.mountBody(body)

    const { el: controlsEl, destroy } = createMediaControls(this.audio, {
      className: 'audio-controls',
    })
    this.controlsDestroy = destroy
    this.dom.appendChild(controlsEl)
  }

  protected renderBody(): HTMLElement {
    // Built in the constructor (see mountBody call). Returning the
    // existing body keeps BaseCardNodeView's contract well-formed.
    if (!this.bodyEl) {
      throw new Error('[audio-card] renderBody called before constructor wired body')
    }
    return this.bodyEl
  }

  protected updateBody(node: PMNode): boolean {
    // Only touch the input when the attr genuinely differs, so a
    // focused / typing user doesn't have their caret reset.
    const nextTitle = (node.attrs.title as string) ?? ''
    if (this.lastTitle !== nextTitle && this.titleInput.value !== nextTitle) {
      this.titleInput.value = nextTitle
    }
    this.lastTitle = nextTitle
    void this.applySrc(node.attrs.src as string | undefined)
    return true
  }

  /** Tell PM not to process events that originate inside the title
   * input host. Covers the input element itself and the
   * contenteditable=true wrapper around it — both need to stay
   * outside PM's input pipeline so the input keeps focus, accepts
   * keystrokes, and doesn't get its DOM selection reinterpreted as
   * a doc selection. Scoped to `this.titleHost` so the rest of the
   * card body (hidden `<audio>`, controls layer) still flows
   * through PM normally — that's how the surrounding mousedown can
   * still drive a card drag. */
  stopEvent(event: Event): boolean {
    return (
      event.target instanceof Node &&
      this.titleHost.contains(event.target)
    )
  }

  override destroy(): void {
    this.titleInput.removeEventListener('input', this.onTitleInput)
    this.controlsDestroy()
    super.destroy()
  }

  private onTitleInput = (): void => {
    const pos = this.getPos()
    if (pos == null) return
    const next = this.titleInput.value
    if (this.lastTitle === next) return
    this.lastTitle = next
    const { state } = this.view
    const node = state.doc.nodeAt(pos)
    if (!node) return
    this.view.dispatch(
      state.tr.setNodeMarkup(pos, undefined, {
        ...node.attrs,
        title: next,
      }),
    )
  }

  private async applySrc(rawSrc: string | undefined): Promise<void> {
    if (this.lastSrc === rawSrc) return
    this.lastSrc = rawSrc
    if (!rawSrc) {
      this.audio.removeAttribute('src')
      return
    }
    try {
      const resolved = await resolveVaultAssetSrc(rawSrc)
      if (this.lastSrc !== rawSrc) return
      if (resolved === null) {
        this.audio.removeAttribute('src')
      } else {
        this.audio.src = resolved
      }
    } catch (err) {
      console.warn('[audio-card] resolve failed', { rawSrc, err })
    }
  }
}

export const audioNodeView = $prose(
  () =>
    new Plugin({
      props: {
        nodeViews: {
          audioBlock: (node, view, getPos) =>
            new AudioCardNodeView(node, view, getPos),
        },
      },
    }),
)
