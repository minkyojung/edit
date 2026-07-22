// Inline YouTube embed for CodeMirror — the unified-view way to show a
// video: a body line that is just a YouTube URL renders as a lite player
// (thumbnail → click → youtube-nocookie iframe), instead of a special
// "youtube doc type" with its own header. Modelled on mediaCards: a
// block-replace widget revealed back to raw text when the caret is on the
// line. Requires the CSP `frame-src`/`img-src` opened to youtube(-nocookie)
// /ytimg (tauri.conf.json).

import { syntaxTree } from '@codemirror/language'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import { StateField, type EditorState, type Extension, type Range, type Transaction } from '@codemirror/state'

import { cursorInRange } from './v2/cursorRange'
import { detectYoutubeEmbed } from '@/lib/youtube'
import { useYoutubePlayerStore } from '@/state/youtubePlayerStore'

// The widget's wrapper DOM carries its store-subscription cleanup so
// destroy() can drop it (CM reuses/destroys widget DOM, not instances).
type WrapEl = HTMLElement & { __ytUnsub?: () => void }

class YoutubeWidget extends WidgetType {
  constructor(readonly videoId: string) {
    super()
  }
  // Identity = videoId → an unrelated edit elsewhere keeps the live player
  // (and its playback position) instead of remounting it.
  eq(other: YoutubeWidget) {
    return other.videoId === this.videoId
  }
  toDOM() {
    const wrap = document.createElement('div')
    wrap.className = 'cm-youtube-card'
    wrap.style.cssText =
      'aspect-ratio:16/9;width:100%;max-width:640px;margin:0.5rem 0;border-radius:0.5rem;overflow:hidden;background:#000;'

    // Lite poster: thumbnail + play button. The iframe loads only on click.
    const poster = document.createElement('button')
    poster.type = 'button'
    poster.setAttribute('aria-label', 'Play video')
    poster.style.cssText =
      'position:relative;display:block;width:100%;height:100%;border:0;padding:0;cursor:pointer;background:#000;'

    const img = document.createElement('img')
    img.src = `https://i.ytimg.com/vi/${this.videoId}/hqdefault.jpg`
    img.alt = ''
    img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;opacity:0.9;'
    poster.appendChild(img)

    const play = document.createElement('span')
    play.textContent = '▶'
    play.style.cssText =
      'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:2rem;color:#fff;text-shadow:0 1px 6px rgba(0,0,0,0.6);'
    poster.appendChild(play)

    // The live iframe, once the poster is clicked. Kept so a later seek
    // request can postMessage it instead of remounting.
    let iframe: HTMLIFrameElement | null = null
    const mountIframe = (startSec: number) => {
      iframe = document.createElement('iframe')
      const start = startSec > 0 ? `&start=${Math.floor(startSec)}` : ''
      iframe.src = `https://www.youtube-nocookie.com/embed/${this.videoId}?autoplay=1&enablejsapi=1&rel=0${start}`
      iframe.title = 'YouTube video player'
      iframe.allow =
        'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share'
      iframe.allowFullscreen = true
      iframe.style.cssText = 'width:100%;height:100%;border:0;display:block;'
      wrap.replaceChildren(iframe)
    }

    poster.addEventListener('click', () => mountIframe(0))

    // A clicked transcript/summary timestamp pushes a seek request here.
    // Already playing → postMessage seekTo; not yet → start at that point.
    const unsub = useYoutubePlayerStore.subscribe((s) => {
      const seek = s.pendingSeek
      if (!seek || seek.videoId !== this.videoId) return
      if (iframe?.contentWindow) {
        iframe.contentWindow.postMessage(
          JSON.stringify({ event: 'command', func: 'seekTo', args: [seek.sec, true] }),
          '*',
        )
      } else {
        mountIframe(seek.sec)
      }
    })
    ;(wrap as WrapEl).__ytUnsub = unsub

    wrap.appendChild(poster)
    return wrap
  }
  // CM removed the widget's DOM (line edited away / caret revealed it) →
  // drop the store subscription so it doesn't leak or seek a dead iframe.
  destroy(dom: HTMLElement) {
    ;(dom as WrapEl).__ytUnsub?.()
  }
  // Ignore widget-internal events so clicking the player never moves CM's
  // selection. To edit the URL, reveal the raw line (caret onto it).
  ignoreEvent() {
    return true
  }
}

function build(state: EditorState): DecorationSet {
  const out: Range<Decoration>[] = []
  syntaxTree(state).iterate({
    enter: (node) => {
      // A bare URL line parses as a Paragraph; match the whole-line URL.
      if (node.name !== 'Paragraph') return undefined
      const text = state.doc.sliceString(node.from, node.to)
      const embed = detectYoutubeEmbed(text)
      if (!embed) return undefined
      const lineFrom = state.doc.lineAt(node.from)
      const lineTo = state.doc.lineAt(Math.min(node.to, state.doc.length))
      // Selection touching the card lines → show the raw URL (same edge-inclusive
      // predicate the v2 block layer uses, so every card reveals consistently).
      if (cursorInRange(state, lineFrom.from, lineTo.to)) return false
      out.push(
        Decoration.replace({
          widget: new YoutubeWidget(embed.videoId),
          block: true,
        }).range(lineFrom.from, lineTo.to),
      )
      return false
    },
  })
  return Decoration.set(out, true)
}

/** Could this edit change which YouTube embeds render? True when a change
 * overlaps an existing (mapped) widget or lands on a line mentioning a YouTube
 * URL (`youtu`). Conservative — over-rebuilds rather than risk a stale embed;
 * when false the mapped set is kept, so typing elsewhere never re-walks the whole
 * syntax tree. Mirrors blocks.ts's `touchesBlocks`. */
function touchesYoutube(tr: Transaction, mapped: DecorationSet): boolean {
  let touched = false
  tr.changes.iterChanges((_fromA, _toA, fromB, toB) => {
    if (touched) return
    mapped.between(fromB, toB, () => {
      touched = true
      return false
    })
    // Scan every line the change spans (not just the first) so a multi-line paste
    // whose YouTube URL isn't on line 1 still triggers a rebuild.
    const first = tr.state.doc.lineAt(fromB).number
    const last = tr.state.doc.lineAt(toB).number
    for (let n = first; n <= last && !touched; n++) {
      if (tr.state.doc.line(n).text.includes('youtu')) touched = true
    }
  })
  return touched
}

export const youtubeCards: Extension = StateField.define<DecorationSet>({
  create: (state) => build(state),
  update: (value, tr) => {
    const mapped = value.map(tr.changes)
    // Doc edit: keep the mapped (position-shifted) set unless the change could
    // add/remove/alter an embed — only then re-walk the tree. This is what stops
    // the per-keystroke full-document scan.
    if (tr.docChanged) return touchesYoutube(tr, mapped) ? build(tr.state) : mapped
    // Caret moved (reveal): positions didn't shift, so rebuild without mapping.
    if (tr.selection) return build(tr.state)
    // Parse-progress: the tree advanced (a bare YouTube URL line may now be a matching
    // Paragraph node) — rebuild so it renders as soon as the parser catches up. Cheap
    // pointer compare; only fires on pure parse-progress transactions (after the gates).
    if (syntaxTree(tr.startState) != syntaxTree(tr.state)) return build(tr.state)
    return mapped
  },
  provide: (f) => [
    EditorView.decorations.from(f),
    EditorView.atomicRanges.of((view) => view.state.field(f)),
  ],
})
