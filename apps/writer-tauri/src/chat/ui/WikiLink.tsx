// Rendered by Streamdown's `components.a` slot when the incoming
// anchor carries a `data-wikilink-slug` attribute. The matching
// mdast plugin (`remarkWikilink.ts`) emits a standard `<a>` with
// `data-wikilink-slug` + `data-wikilink-broken`; this component
// turns those markers into the click-to-navigate button the chat
// panel actually shows.
//
// Why props arrive as strings: hast → React serialises every
// attribute as a string, so `data-wikilink-broken` lands as
// `'true' | 'false'`, not a boolean. We coerce at the top of the
// component.
//
// Click behaviour mirrors the doc editor's `wikilinkClickPlugin.ts`:
// look up the slug in `knownDocs`, refuse to navigate if archived
// or missing (defensive — the broken flag should have caught those
// at mdast time, but knownDocs can change between render and click).

import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useDocsStore } from '@/state/docsStore'
import { buildViewUrl } from '@/lib/viewUrl'

interface Props {
  'data-wikilink-slug'?: string
  'data-wikilink-broken'?: string
  children?: ReactNode
}

export function WikiLink(props: Props) {
  const rawSlug = props['data-wikilink-slug']
  const slug = rawSlug && rawSlug.length > 0 ? rawSlug : undefined
  const broken = props['data-wikilink-broken'] === 'true'
  const navigate = useNavigate()

  if (!slug || broken) {
    // Render the citation as visible bracketed text so the reader
    // still sees the intended reference. Muted styling matches the
    // doc-side `wikilink-broken` class semantics.
    return <span className="text-muted-foreground">[[{props.children}]]</span>
  }
  return (
    <button
      type="button"
      onClick={() => {
        const store = useDocsStore.getState()
        const target = store.knownDocs.find((d) => d.slug === slug)
        if (!target) return
        navigate(
          buildViewUrl({
            tab: store.sidebarTab,
            dayAnchor: store.dayAnchor,
            monthAnchor: store.monthAnchor,
            slug,
          }),
        )
      }}
      className="inline text-foreground underline decoration-foreground/40 underline-offset-2 hover:decoration-foreground"
    >
      {props.children}
    </button>
  )
}
