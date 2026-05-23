// Routes clicks on inline wikilink atoms to the docs registry so the
// editor switches to the target doc instead of trying to follow the
// dummy `href="#"` we render for accessibility.
//
// Lives as a pure ProseMirror plugin (no React) so the editor can
// resolve the click before any Milkdown collab handling kicks in.
// The store action is imported lazily through getState() so the
// plugin doesn't carry a reference that fights HMR.

import { $prose } from '@milkdown/kit/utils'
import { Plugin } from '@milkdown/kit/prose/state'
import { useDocsStore } from '@/state/docsStore'
import { buildViewUrl } from '@/lib/viewUrl'
import { isWikilinkHref, slugFromWikilinkHref } from './wikilinkPalettePlugin'

export function createWikilinkClickPlugin() {
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
              if (!isWikilinkHref(href)) return false
              event.preventDefault()
              const slug = slugFromWikilinkHref(href!)
              const store = useDocsStore.getState()
              const target = store.knownDocs.find((d) => d.slug === slug)
              if (!target) {
                // Broken link — slug isn't in the registry.
                return true
              }
              if (target.archivedAt) {
                // Archived — link looks disabled and clicking is a
                // no-op. User has to restore from Archive first.
                return true
              }
              // PM plugin runs outside React, so we drive navigation
              // through location.hash (HashRouter listens on
              // hashchange). useRouteSync then mirrors the new URL
              // into the store, which calls setActive — that's where
              // the openSlugs append + ensureHandle still happens.
              window.location.hash = buildViewUrl({
                tab: store.sidebarTab,
                dayAnchor: store.dayAnchor,
                monthAnchor: store.monthAnchor,
                slug,
              })
              return true
            },
          },
        },
      }),
  )
}
