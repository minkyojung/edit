// Assigns a stable `vizId` to every visualization code block (chart / mermaid /
// artifact / github-activity) that lacks one, and reassigns on collision (e.g.
// a copy-pasted block) so each id addresses exactly one block. The id rides in
// the fence meta (see code-block-ext.ts) so it persists across reloads and can
// be referenced from any chat session to edit that specific block.

import { $prose } from '@milkdown/kit/utils'
import { Plugin, type Transaction } from '@milkdown/kit/prose/state'
import { nanoid } from 'nanoid'

const VIZ_LANGS = new Set(['chart', 'mermaid', 'artifact', 'github-activity'])

export const vizIdPlugin = $prose(
  () =>
    new Plugin({
      appendTransaction(transactions, _oldState, newState) {
        if (!transactions.some((tr) => tr.docChanged)) return null
        let tr: Transaction | null = null
        const seen = new Set<string>()
        newState.doc.descendants((node, pos) => {
          if (node.type.name !== 'code_block') return
          const lang = String(node.attrs.language || '').toLowerCase()
          if (!VIZ_LANGS.has(lang)) return
          const id = node.attrs.vizId as string
          if (id && !seen.has(id)) {
            seen.add(id)
            return
          }
          // Missing or duplicate → assign a fresh id.
          const fresh = nanoid(10)
          seen.add(fresh)
          if (!tr) tr = newState.tr
          tr.setNodeMarkup(pos, undefined, { ...node.attrs, vizId: fresh })
        })
        if (tr) (tr as Transaction).setMeta('addToHistory', false)
        return tr
      },
    }),
)
