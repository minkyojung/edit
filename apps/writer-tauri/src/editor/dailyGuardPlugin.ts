// Daily-doc structural guard. Mirror of titleGuardPlugin for the
// inverted invariant: daily docs render their date label outside the
// editor (a readonly heading rendered by the layout), so the body
// MUST NOT lead with an h1. Otherwise the user sees the date label
// AND an empty h1 stacked on top of the body, with the body
// placeholder pushed below — a visual regression that previously
// reached the user when a race in normalizeTitleStructure
// misclassified a daily as a writing doc and stamped the h1 the
// non-daily branch normally creates.
//
// What this plugin enforces:
//
//   1. filterTransaction — any LOCAL transaction whose result has an
//      h1 as the first block is rejected. Slash-command /h1 at the
//      top, paste of "# ...", schema-level promotion via the toolbar
//      while the cursor is in the first block — all blocked. Daily is
//      semantically a quick log; if the user needs heading structure,
//      h2/h3 still work, and inserting an h1 after some content is
//      also allowed (because then it isn't the first block).
//
//   2. appendTransaction — after every state change (including remote
//      y-prosemirror sync trs), if the doc has come to have an EMPTY
//      h1 as its first block, append a delete tr to remove it. This
//      repairs docs that already carry the h1 from a pre-fix render —
//      no migration flag needed, the invariant simply enforces itself
//      the moment the doc is loaded. Non-empty h1s (which would
//      indicate real user content) are left alone to avoid data loss,
//      even though that means the invariant isn't perfectly held in
//      that edge case.
//
// What this plugin does NOT do:
//   - Touch writing/wiki docs. MilkdownEditor picks between
//     titleGuardPlugin and dailyGuardPlugin based on the catalog's
//     knownDoc.type, so the two guards are mutually exclusive per
//     editor instance.
//   - Block remote updates. The ySyncPluginKey-meta path is allowed
//     through filterTransaction so collab stays in sync; the
//     appendTransaction repair is what normalizes any leading h1
//     a remote peer might have sent.

import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { ySyncPluginKey } from 'y-prosemirror'
import { SYSTEM_DOC_INIT_META } from './titleGuardPlugin'

const dailyGuardKey = new PluginKey('writer-daily-guard')

function isLevel1Heading(
  node: { type: { name: string }; attrs: { level?: number } } | null | undefined,
): boolean {
  if (!node) return false
  if (node.type.name !== 'heading') return false
  return node.attrs.level === 1
}

export const dailyGuardPlugin = $prose(
  () =>
    new Plugin({
      key: dailyGuardKey,
      filterTransaction(tr, _state) {
        // Remote (y-prosemirror): never filter, would desync. The
        // appendTransaction below picks up any leading h1 the remote
        // brought in and emits a normalization tr for it.
        if (tr.getMeta(ySyncPluginKey)) return true

        // System-driven (our own repair tr from appendTransaction, or
        // docTitle.ts migrations) — always allow so the plugin can
        // dispatch its own corrective edits without recursing through
        // its own filter.
        if (tr.getMeta(SYSTEM_DOC_INIT_META)) return true

        // Selection moves, marks, decorations — no structural impact.
        if (!tr.docChanged) return true

        // The actual rule: after applying this tr, the first block
        // must not be a level-1 heading.
        return !isLevel1Heading(tr.doc.firstChild)
      },
      appendTransaction(transactions, _oldState, newState) {
        // Cheap fast-paths: no doc change, or we already emitted a
        // repair in the same batch. The marker check prevents the
        // appendTransaction from re-firing on its own output.
        if (transactions.every((t) => !t.docChanged)) return null
        if (transactions.some((t) => t.getMeta(SYSTEM_DOC_INIT_META))) return null

        const first = newState.doc.firstChild
        if (!isLevel1Heading(first)) return null
        // Preserve real user text — only auto-remove the empty
        // sentinel-shaped h1 that the legacy non-daily branch used to
        // stamp on freshly-opened dailies. A daily that somehow ended
        // up with "오늘의 메모" as its first h1 belongs to the user,
        // not to us, so we keep it visible even though it technically
        // violates the invariant; the user can delete it manually.
        if (first!.textContent.length > 0) return null

        const tr = newState.tr.delete(0, first!.nodeSize)
        tr.setMeta(SYSTEM_DOC_INIT_META, true)
        tr.setMeta('addToHistory', false)
        return tr
      },
    }),
)
