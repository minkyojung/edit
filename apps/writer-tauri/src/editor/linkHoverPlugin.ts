// Detect hover on rendered link anchors and push the active link to
// linkHoverStore so the React-side hover bar (Step 3) can position
// itself and read href/range. UI-free on its own — verify via the
// dev console: window.linkHoverStore.subscribe(...).
//
// Wikilinks are excluded for free because their href ("note:slug")
// fails the safe-scheme allow list. markHoverPlugin (proofMark) is
// orthogonal: it watches .mark-deco* spans, we watch <a> — the two
// never compete for the same target.

import { $prose } from '@milkdown/kit/utils'
import { Plugin } from '@milkdown/kit/prose/state'

import { useLinkHoverStore } from '@/state/linkHoverStore'
import { getLinkRange, isSafeUrl } from './linkUtils'

const HOVER_IN_MS = 300
const HOVER_OUT_MS = 150

// Module-level so the React-side hover bar can pause/resume the close
// timer as the cursor crosses the gap between the link and the bar.
// Single editor at a time so a single shared instance is fine.
let activeOutTimer: number | null = null
let keepAlive = false

export function keepLinkHoverAlive() {
  keepAlive = true
  if (activeOutTimer !== null) {
    window.clearTimeout(activeOutTimer)
    activeOutTimer = null
  }
}

export function releaseLinkHoverAlive() {
  keepAlive = false
}

export function createLinkHoverPlugin() {
  return $prose(() => {
    let currentAnchor: HTMLAnchorElement | null = null
    let inTimer: number | null = null

    const cancelTimers = () => {
      if (inTimer !== null) {
        window.clearTimeout(inTimer)
        inTimer = null
      }
      if (activeOutTimer !== null) {
        window.clearTimeout(activeOutTimer)
        activeOutTimer = null
      }
    }

    return new Plugin({
      view() {
        return {
          destroy() {
            cancelTimers()
            keepAlive = false
            currentAnchor = null
            useLinkHoverStore.getState().setActive(null)
          },
        }
      },
      props: {
        handleDOMEvents: {
          mouseover(view, event) {
            // Suppress while selecting — bar over a drag is noisy.
            if (!view.state.selection.empty) return false

            const anchor = (event.target as HTMLElement | null)?.closest(
              'a',
            ) as HTMLAnchorElement | null
            if (!anchor) return false

            const href = anchor.getAttribute('href')
            if (!href || !isSafeUrl(href)) return false

            // Same anchor → dedupe the per-character mouseover storm.
            if (anchor === currentAnchor) return false

            cancelTimers()
            inTimer = window.setTimeout(() => {
              const range = getLinkRange(view, anchor)
              if (!range) return
              currentAnchor = anchor
              useLinkHoverStore.getState().setActive({
                href: range.href,
                from: range.from,
                to: range.to,
                anchor,
              })
            }, HOVER_IN_MS)
            return false
          },
          mouseout(_view, event) {
            const anchor = (event.target as HTMLElement | null)?.closest(
              'a',
            ) as HTMLAnchorElement | null
            if (!anchor) return false

            // Cursor moving to another segment of the same link (line
            // wrap splits an <a> into multiple boxes) — not a leave.
            const related = (event as MouseEvent).relatedTarget as
              | HTMLElement
              | null
            const relAnchor = related?.closest?.('a') as HTMLAnchorElement | null
            if (
              relAnchor &&
              relAnchor.getAttribute('href') === anchor.getAttribute('href')
            ) {
              return false
            }

            cancelTimers()
            activeOutTimer = window.setTimeout(() => {
              activeOutTimer = null
              if (keepAlive) return
              currentAnchor = null
              useLinkHoverStore.getState().setActive(null)
            }, HOVER_OUT_MS)
            return false
          },
        },
      },
    })
  })
}
