// Strips dangerous link hrefs out of pasted HTML at the editor
// boundary. Without this, copying from a page that contains
// `<a href="javascript:alert(1)">click</a>` puts the executable URL
// straight into the doc; the rendered <a> looks like an ordinary
// link, and a plain click in the editor follows the browser's
// default for <a>, which runs the script.
//
// We only allow http / https / mailto on paste, plus our own
// `note:` wikilink scheme so copy-paste between docs preserves
// internal links. Anything else has its `href` attribute removed —
// the anchor stays as plain text and Milkdown's commonmark
// link-mark parseDOM, which requires an href, never produces a
// mark.
//
// Defense in depth: linkClickPlugin runs `isSafeUrl` again at
// Cmd-click time. This plugin is the upstream gate so a malicious
// href doesn't sit in the doc waiting for that gate to trip.

import { $prose } from '@milkdown/kit/utils'
import { Plugin } from '@milkdown/kit/prose/state'

import { isSafeUrl } from './linkUtils'
import { WIKILINK_HREF_PREFIX } from './wikilinkPalettePlugin'

function isPasteAllowedHref(href: string): boolean {
  if (isSafeUrl(href)) return true
  // Preserve internal wikilinks when content is copy-pasted between
  // our own docs. External pasters won't normally produce note:
  // hrefs, and even if they did, wikilinkClickPlugin resolves the
  // slug against knownDocs — unknown slugs no-op, they don't escape.
  return href.toLowerCase().trim().startsWith(WIKILINK_HREF_PREFIX)
}

export function createPasteSanitizerPlugin() {
  return $prose(
    () =>
      new Plugin({
        props: {
          transformPastedHTML(html) {
            const dom = new DOMParser().parseFromString(html, 'text/html')
            for (const anchor of Array.from(dom.querySelectorAll('a'))) {
              const href = anchor.getAttribute('href')
              if (!href) continue
              if (isPasteAllowedHref(href)) continue
              anchor.removeAttribute('href')
            }
            return dom.body.innerHTML
          },
        },
      }),
  )
}
