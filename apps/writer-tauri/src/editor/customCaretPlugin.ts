// Custom caret.
//
// On macOS WebKit the native text caret is drawn at the full LINE-BOX height
// (= line-height), not the text height — by design (WebKit bug 13820, closed
// WONTFIX). With our reading-comfort line-height (1.7 / 27px) that makes the
// caret tower over the ~18px glyphs, and any per-line line-box variation shows
// up as an uneven caret. No CSS/font/line-height combination fixes it, so we do
// what CodeMirror (`drawSelection`) and Monaco do: hide the native caret and
// draw our own at a height we control.
//
// Geometry comes from `coordsAtPos`, which reports the TEXT box (top..bottom ≈
// font ascent+descent), uniform line-to-line — so our caret hugs the text and
// stays the same height everywhere.
//
// IME: while composing (Korean/Japanese/…) the native caret + composition
// underline must stay visible, so we hide ours and un-hide the native one for
// the duration of the composition.

import { $prose } from '@milkdown/kit/utils'
import { Plugin } from '@milkdown/kit/prose/state'

export function createCustomCaretPlugin() {
  return $prose(() => {
    return new Plugin({
      view(view) {
        const caret = document.createElement('div')
        caret.className = 'pm-custom-caret'
        caret.setAttribute('aria-hidden', 'true')
        document.body.appendChild(caret)

        let raf = 0
        let lastLeft = Number.NaN
        let lastTop = Number.NaN

        // Hide the native caret only while ours is shown — during selection,
        // blur, or IME composition the native one must come back.
        const hideNative = (on: boolean) => {
          view.dom.classList.toggle('pm-native-caret-hidden', on)
        }

        // The visible viewport to clip against: the nearest scrolling ancestor
        // (so the caret never bleeds over the header/footer when scrolled).
        const findScroller = (): HTMLElement | null => {
          let el = view.dom.parentElement
          while (el) {
            const oy = getComputedStyle(el).overflowY
            if (oy === 'auto' || oy === 'scroll') return el
            el = el.parentElement
          }
          return null
        }
        const scroller = findScroller()

        const place = () => {
          raf = 0
          const sel = view.state.selection
          const showOurs = view.hasFocus() && sel.empty && !view.composing
          if (!showOurs) {
            caret.style.display = 'none'
            hideNative(false)
            return
          }

          let coords: { left: number; top: number; bottom: number }
          try {
            coords = view.coordsAtPos(sel.head)
          } catch {
            caret.style.display = 'none'
            hideNative(false)
            return
          }

          // Clip to the scroll viewport.
          const clip = scroller?.getBoundingClientRect()
          if (clip && (coords.bottom < clip.top || coords.top > clip.bottom)) {
            caret.style.display = 'none'
            hideNative(true) // text is scrolled out; native is hidden too (no caret visible)
            return
          }

          hideNative(true)
          caret.style.display = 'block'
          caret.style.left = `${coords.left}px`
          caret.style.top = `${coords.top}px`
          caret.style.height = `${coords.bottom - coords.top}px`

          // Restart the blink so the caret shows solid the instant it moves —
          // matching native behaviour — but only when it actually moved, so
          // background transactions don't freeze the blink.
          if (coords.left !== lastLeft || coords.top !== lastTop) {
            caret.style.animation = 'none'
            void caret.offsetHeight // force reflow
            caret.style.animation = ''
            lastLeft = coords.left
            lastTop = coords.top
          }
        }

        const schedule = () => {
          if (raf) return
          raf = window.requestAnimationFrame(place)
        }

        // The editor can be resized WITHOUT a window resize — dragging the
        // chat-panel divider changes the editor width, which rewraps the text
        // and moves every caret position. A ResizeObserver on the editor
        // element catches that and ordinary window resizes alike; the caret is
        // repositioned on the next tick. (Replaces a window 'resize' listener,
        // which never fires on a panel drag.)
        const resizeObserver = new ResizeObserver(schedule)
        resizeObserver.observe(view.dom)

        // A web font finishing load reflows the text and shifts every caret
        // position, but fires no transaction — so the caret would sit stale.
        // Pretendard loads glyph subsets on demand, so we listen to the
        // recurring `loadingdone` (fires after each batch) rather than the
        // one-shot `document.fonts.ready` CodeMirror uses, to catch later
        // subsets too. Reposition on the next tick.
        document.fonts.addEventListener('loadingdone', schedule)

        // coordsAtPos is viewport-relative, so scrolling also moves it.
        window.addEventListener('scroll', schedule, true)
        view.dom.addEventListener('focus', schedule)
        view.dom.addEventListener('blur', schedule)
        view.dom.addEventListener('compositionstart', schedule)
        view.dom.addEventListener('compositionend', schedule)

        schedule()

        return {
          update() {
            schedule()
          },
          destroy() {
            if (raf) cancelAnimationFrame(raf)
            resizeObserver.disconnect()
            document.fonts.removeEventListener('loadingdone', schedule)
            window.removeEventListener('scroll', schedule, true)
            view.dom.removeEventListener('focus', schedule)
            view.dom.removeEventListener('blur', schedule)
            view.dom.removeEventListener('compositionstart', schedule)
            view.dom.removeEventListener('compositionend', schedule)
            hideNative(false)
            caret.remove()
          },
        }
      },
    })
  })
}
