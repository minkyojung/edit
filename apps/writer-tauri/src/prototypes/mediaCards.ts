// Spike: render `<video>` / `<audio>` HTML blocks as media cards in
// CodeMirror, REUSING the app's vanilla `createMediaControls` (play/seek/
// volume) and the existing [data-card-controls] CSS unchanged. Same proof as
// the chart spike: a block-replace widget whose eq() preserves the live media
// element (and its playback position) across unrelated edits, editable via
// cursor-reveal.
//
// vs the ProseMirror card: the audio "title" here is just the `title="..."`
// markdown attribute (edit by revealing source) — the WebKit contenteditable
// input hack disappears.

import { syntaxTree } from '@codemirror/language'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import { EditorSelection, StateField, type EditorState, type Extension, type Range } from '@codemirror/state'
import { activeLines } from './reveal'
import { isComposing, compositionEnded } from './imeComposition'

type MediaKind = 'video' | 'audio'

function readAttr(tag: string, name: string): string {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag)
  return m ? (m[2] ?? m[3] ?? '') : ''
}

export function detectMedia(text: string): { kind: MediaKind; src: string; title: string } | null {
  const m = /^<(video|audio)\b/i.exec(text.trim())
  if (!m) return null
  const kind = m[1].toLowerCase() as MediaKind
  const src = readAttr(text, 'src')
  if (!src) return null
  return { kind, src, title: readAttr(text, 'title') }
}

export class MediaWidget extends WidgetType {
  constructor(
    readonly kind: MediaKind,
    readonly src: string,
    readonly title: string,
  ) {
    super()
  }
  // Identity = kind + src + title → unchanged media keeps its DOM (and the
  // <video>/<audio> element's current playback time) across edits elsewhere.
  eq(other: MediaWidget) {
    return other.kind === this.kind && other.src === this.src && other.title === this.title
  }
  // SPIKE: native webview controls instead of the custom `createMediaControls`
  // bar. toDOM gets the `view` so the edit-source button can dispatch a selection.
  toDOM(view: EditorView) {
    const fig = document.createElement('figure')
    fig.className = 'cm-media-card'
    fig.dataset.card = this.kind

    const media = document.createElement(this.kind) as HTMLMediaElement
    media.src = this.src
    if (this.title) media.title = this.title
    // NATIVE controls — the OS webview (WKWebView on macOS) renders its own
    // Safari/QuickTime-style player chrome. The reason the PM editor couldn't use
    // these (shadow-DOM scrubber/volume events misread as a card drag) is gone in
    // CM: CM has no `mightDrag` trap and gates purely on `ignoreEvent()` below,
    // which returns true so none of the controls' events reach the editor.
    media.controls = true
    media.setAttribute('preload', this.kind === 'video' ? 'auto' : 'metadata')
    fig.appendChild(media)

    // Because `ignoreEvent()` is true, clicking the card no longer reveals the
    // raw `<video src=...>` markup (that click never reaches CM now). So give an
    // explicit affordance: a button that drops a caret on the media line → the
    // field swaps the widget for raw source (`cursorInRange`). Arrowing a caret
    // in from an adjacent line still works too (keyboard is unaffected by
    // `ignoreEvent`). The button uses its OWN listener + `view.dispatch`.
    const edit = document.createElement('button')
    edit.type = 'button'
    edit.className = 'cm-media-edit'
    edit.textContent = '</>'
    edit.setAttribute('aria-label', 'Edit source')
    edit.addEventListener('mousedown', (e) => {
      e.preventDefault()
      const pos = view.posAtDOM(fig)
      const line = view.state.doc.lineAt(pos)
      view.dispatch({ selection: EditorSelection.cursor(line.from) })
      view.focus()
    })
    fig.appendChild(edit)
    return fig
  }
  // Ignore EVERY widget-internal event so the native controls operate freely and
  // never move CM's selection (no reveal-on-play). To MOVE the block you reveal
  // the raw `<video>`/`<audio>` line (`</>` or a caret) and drag/cut that TEXT —
  // a normal text move, so no drag handle is needed here.
  ignoreEvent() {
    return true
  }
}

function build(state: EditorState): DecorationSet {
  const out: Range<Decoration>[] = []
  const active = activeLines(state)
  syntaxTree(state).iterate({
    enter: (node) => {
      // lang-markdown parses `<video>/<audio>` as a Paragraph holding HTMLTag
      // children (they're not CommonMark HTML-block tags), so match the
      // Paragraph whose text is a media tag.
      if (node.name !== 'Paragraph') return undefined
      const text = state.doc.sliceString(node.from, node.to)
      const media = detectMedia(text)
      if (!media) return undefined
      const lineFrom = state.doc.lineAt(node.from)
      const lineTo = state.doc.lineAt(Math.min(node.to, state.doc.length))
      for (let n = lineFrom.number; n <= lineTo.number; n++) {
        if (active.has(n)) return false // cursor here → show raw source
      }
      out.push(
        Decoration.replace({
          widget: new MediaWidget(media.kind, media.src, media.title),
          block: true,
        }).range(lineFrom.from, lineTo.to),
      )
      return false // don't descend into the HTMLTag children
    },
  })
  return Decoration.set(out, true)
}

export const mediaField = StateField.define<DecorationSet>({
  create: (state) => build(state),
  update: (value, tr) => {
    if (isComposing(tr.state)) return value
    return tr.docChanged || tr.selection || compositionEnded(tr) ? build(tr.state) : value
  },
  provide: (f) => [
    EditorView.decorations.from(f),
    EditorView.atomicRanges.of((view) => view.state.field(f)),
  ],
})

export const mediaCards: Extension = mediaField
