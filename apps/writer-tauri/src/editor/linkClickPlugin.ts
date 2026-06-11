// Cmd/Ctrl-click on a link mark opens the URL in the system browser
// instead of moving the editor caret. Plain clicks still place the
// cursor (so editing the link text stays easy).
//
// We hook DOM-level click rather than PM's handleClick because the
// rendered `<a>` is what the cursor actually lands on, and DOM-level
// gives us the closest ancestor anchor regardless of nested nodes
// (e.g. a styled span inside the link). This mirrors how
// wikilinkClickPlugin captures wikilink anchors.

import { $prose } from '@milkdown/kit/utils'
import { Plugin } from '@milkdown/kit/prose/state'

import { openLinkSafely } from './linkUtils'
import { parseYoutubeTimestampLink } from '@/lib/youtube'
import { useYoutubePlayerStore } from '@/state/youtubePlayerStore'

export function createLinkClickPlugin() {
  return $prose(
    () =>
      new Plugin({
        props: {
          handleDOMEvents: {
            click(_view, event) {
              const anchor = (event.target as HTMLElement | null)?.closest(
                'a',
              ) as HTMLAnchorElement | null
              if (!anchor) return false

              const href = anchor.getAttribute('href')
              if (!href) return false

              // A transcript/summary timestamp: a plain click seeks the
              // embedded player to that moment instead of opening a tab.
              const ts = parseYoutubeTimestampLink(href)
              if (ts) {
                useYoutubePlayerStore.getState().requestSeek(ts.videoId, ts.sec)
                event.preventDefault()
                return true
              }

              // Other links keep the Cmd/Ctrl-click → system browser rule;
              // a plain click still places the caret for editing.
              if (!event.metaKey && !event.ctrlKey) return false
              if (!openLinkSafely(href)) return false
              event.preventDefault()
              return true
            },
          },
        },
      }),
  )
}
