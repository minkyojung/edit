// `<video>` / `<audio>` media detection + block widget. The widget's eq()
// preserves the live media element (and its playback position) across unrelated
// edits. Placement/reveal (which lines render as a card) is owned by the v2
// block field (`v2/blocks`), which imports `detectMedia` + `MediaWidget` here.
//
// The audio "title" is just the `title="..."` markdown attribute (edit by
// revealing the raw source).

import { EditorView, WidgetType } from '@codemirror/view'
import { setVaultAssetSrc } from './setAssetSrc'

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
  // SPIKE: native webview controls instead of the custom `createMediaControls` bar.
  toDOM(view: EditorView) {
    const fig = document.createElement('figure')
    fig.className = 'cm-media-card'
    fig.dataset.card = this.kind

    const media = document.createElement(this.kind) as HTMLMediaElement
    setVaultAssetSrc(media, this.src) // resolve vault-relative paths to asset:// URLs
    if (this.title) media.title = this.title
    // Dimensions/height arrive async (loadedmetadata) — re-measure then so CM's
    // heightmap matches the rendered player. Without it, clicks / up-down arrow
    // map to the wrong line for content below the player (stale heightmap).
    media.addEventListener('loadedmetadata', () => view.requestMeasure())
    // NATIVE controls — the OS webview (WKWebView on macOS) renders its own
    // Safari/QuickTime-style player chrome. The reason the PM editor couldn't use
    // these (shadow-DOM scrubber/volume events misread as a card drag) is gone in
    // CM: CM has no `mightDrag` trap and gates purely on `ignoreEvent()` below,
    // which returns true so none of the controls' events reach the editor.
    media.controls = true
    media.setAttribute('preload', this.kind === 'video' ? 'auto' : 'metadata')
    fig.appendChild(media)
    return fig
  }
  // Ignore EVERY widget-internal event so the native controls operate freely and
  // never move CM's selection (no reveal-on-play). To MOVE the block you reveal
  // the raw `<video>`/`<audio>` line (arrow a caret onto it) and drag/cut that
  // TEXT — a normal text move, so no drag handle is needed here.
  ignoreEvent() {
    return true
  }
}
