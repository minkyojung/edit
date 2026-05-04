// Decoration plugin that flags wikilinks whose target slug is either
// missing from the docs registry (broken — slug never resolved here,
// or was permanently deleted) or archived (still on disk but the user
// moved it out of the working tree). Both states get the link's
// anchor text/slug preserved so a future un-archive or sync can
// revive the jump; only the visual treatment differs.
//
// Class assignments:
//   - `wikilink-broken`  — slug not in knownDocs at all.
//   - `wikilink-archived` — slug in knownDocs with archivedAt set.
//                            Looks disabled, hover tooltip explains.
//
// Rebuild triggers:
//   - any docChanged transaction (text edit, link insert/remove).
//   - a docsStore knownDocs change, fed in via a `rebuild` meta
//     from MilkdownEditor's effect that subscribes to the store.

import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { useDocsStore } from '@/state/docsStore'
import {
  isWikilinkHref,
  slugFromWikilinkHref,
} from './wikilinkPalettePlugin'

export const wikilinkBrokenKey = new PluginKey<DecorationSet>('wikilinkBroken')

interface SlugClassification {
  /** Slug is in knownDocs and not archived — link is live. */
  live: Set<string>
  /** Slug is in knownDocs but archivedAt is set. */
  archived: Set<string>
}

function classifySlugs(): SlugClassification {
  const live = new Set<string>()
  const archived = new Set<string>()
  for (const d of useDocsStore.getState().knownDocs) {
    if (d.archivedAt) archived.add(d.slug)
    else live.add(d.slug)
  }
  return { live, archived }
}

function buildDecos(doc: PMNode): DecorationSet {
  const { live, archived } = classifySlugs()
  const decos: Decoration[] = []
  doc.descendants((node, pos) => {
    if (!node.isText) return
    for (const mark of node.marks) {
      if (mark.type.name !== 'link') continue
      const href = mark.attrs.href as string | undefined
      if (!isWikilinkHref(href)) continue
      const slug = slugFromWikilinkHref(href!)
      if (live.has(slug)) continue
      const isArchived = archived.has(slug)
      decos.push(
        Decoration.inline(pos, pos + node.nodeSize, {
          class: isArchived ? 'wikilink-archived' : 'wikilink-broken',
          // HTML title attribute renders as a native tooltip on hover.
          // Only set for archived links — broken links already read as
          // dead via the strikethrough and need no extra explanation.
          ...(isArchived ? { title: 'Archived — restore from Archive to open' } : {}),
        }),
      )
    }
  })
  return DecorationSet.create(doc, decos)
}

export function createWikilinkBrokenPlugin() {
  return $prose(
    () =>
      new Plugin({
        key: wikilinkBrokenKey,
        state: {
          init(_, { doc }) {
            return buildDecos(doc)
          },
          apply(tr, prev) {
            if (tr.docChanged) return buildDecos(tr.doc)
            const meta = tr.getMeta(wikilinkBrokenKey)
            if (meta === 'rebuild') return buildDecos(tr.doc)
            return prev
          },
        },
        props: {
          decorations(state) {
            return wikilinkBrokenKey.getState(state)
          },
        },
      }),
  )
}
