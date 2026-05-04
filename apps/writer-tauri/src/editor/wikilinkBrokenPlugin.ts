// Decoration plugin that flags wikilinks whose target slug isn't in
// the known docs registry — typically because the user explicitly
// removed the child or the doc was created on another device but
// hasn't synced here. The link's anchor text and slug stay in the
// body (so a future sync can revive it), but a `wikilink-broken`
// CSS class adds a muted strikethrough so the reader can tell the
// jump won't go anywhere.
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

function knownSlugSet(): Set<string> {
  return new Set(useDocsStore.getState().knownDocs.map((d) => d.slug))
}

function buildDecos(doc: PMNode): DecorationSet {
  const known = knownSlugSet()
  const decos: Decoration[] = []
  doc.descendants((node, pos) => {
    if (!node.isText) return
    for (const mark of node.marks) {
      if (mark.type.name !== 'link') continue
      const href = mark.attrs.href as string | undefined
      if (!isWikilinkHref(href)) continue
      const slug = slugFromWikilinkHref(href!)
      if (known.has(slug)) continue
      decos.push(
        Decoration.inline(pos, pos + node.nodeSize, {
          class: 'wikilink-broken',
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
