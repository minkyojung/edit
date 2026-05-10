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
import { open } from '@tauri-apps/plugin-shell'

import { notify } from '@/lib/notify'

const SAFE_SCHEMES = ['http://', 'https://', 'mailto:']

function isSafeUrl(href: string): boolean {
  const lower = href.toLowerCase().trim()
  return SAFE_SCHEMES.some((s) => lower.startsWith(s))
}

export function createLinkClickPlugin() {
  return $prose(
    () =>
      new Plugin({
        props: {
          handleDOMEvents: {
            click(_view, event) {
              if (!event.metaKey && !event.ctrlKey) return false

              const anchor = (event.target as HTMLElement | null)?.closest(
                'a',
              ) as HTMLAnchorElement | null
              if (!anchor) return false

              const href = anchor.getAttribute('href')
              if (!href || !isSafeUrl(href)) return false

              event.preventDefault()
              void open(href).catch(() => {
                notify.linkOpenFailed()
              })
              return true
            },
          },
        },
      }),
  )
}
