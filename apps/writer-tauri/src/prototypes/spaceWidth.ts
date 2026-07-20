// Publishes `--cm-space-w`: the pixel advance of ONE space in the editor's body font,
// measured from the real DOM. The list hanging-indent uses it to pull a continuation's
// literal leading spaces back by their EXACT width instead of a hand-picked em guess.
//
// This is the same idea as marijn's own CM5 `indentwrap` demo (wrap indent = leading
// columns × a measured char width): the indent region of a continuation line is only
// spaces, so ONE metric — the space advance — describes it exactly. We measure once per
// font (not per line, unlike Obsidian, which avoids its per-line re-measure reflow bug),
// and re-measure when web fonts finish loading, since the first paint may use a fallback
// font with a different advance.

import { EditorView, ViewPlugin } from '@codemirror/view'
import { type Extension } from '@codemirror/state'

function measureSpaceWidth(view: EditorView): number {
  // Inherit the exact body font by measuring INSIDE the scroller (fontFamily lives on
  // `.cm-scroller`, fontSize on the editor root). `white-space:pre` keeps the spaces from
  // collapsing; 50 of them average out sub-pixel rounding.
  const probe = document.createElement('span')
  probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;pointer-events:none;top:0;left:0'
  probe.textContent = ' '.repeat(50)
  view.scrollDOM.appendChild(probe)
  const w = probe.getBoundingClientRect().width / 50
  probe.remove()
  return w
}

export function spaceWidthProbe(): Extension {
  return ViewPlugin.fromClass(
    class {
      destroyed = false
      constructor(view: EditorView) {
        this.publish(view)
        // Web fonts can swap in after the first paint, changing the advance — re-measure
        // once they're ready. Guard against the view being torn down meanwhile.
        document.fonts?.ready.then(() => {
          if (!this.destroyed) this.publish(view)
        })
      }
      publish(view: EditorView) {
        view.requestMeasure({
          read: (v) => measureSpaceWidth(v),
          write: (w, v) => {
            if (w > 0) v.dom.style.setProperty('--cm-space-w', `${w}px`)
          },
        })
      }
      destroy() {
        this.destroyed = true
      }
    },
  )
}
