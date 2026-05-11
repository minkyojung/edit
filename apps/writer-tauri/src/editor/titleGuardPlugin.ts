// Title-slot integrity guard.
//
// Concept: non-daily docs maintain a structural rule — the first
// child of the doc is always a level-1 heading that serves as the
// title slot. This file enforces that rule at the ProseMirror
// transaction level so any change that would remove or downgrade
// the first h1 is refused, regardless of which source produced
// the change (keyboard, paste, slash command, drag, programmatic).
//
// Why filterTransaction and not a keymap: a keymap only covers
// keystrokes. The same invariant must hold for paste, undo, cut,
// programmatic dispatch, and any future input path we have not
// thought of yet. filterTransaction is the single gateway every
// transaction must pass through before being applied — checking
// here is the highest-leverage point that does not require
// changing the schema (which we tried and could not, because the
// server-side collab pipeline does not understand our custom
// schema additions).
//
// What this plugin does NOT do:
//
//   - It does not synthesize a new h1 when one is missing. Initial
//     insertion is the doc-init normalization's job
//     (lib/docTitle.ts). This plugin only refuses removals.
//   - It does not touch daily docs. The "first child is h1"
//     property is the implicit signal — if the doc never had a
//     leading h1, the invariant does not apply to it.
//   - It does not interfere with remote (collab) updates. Filtering
//     those would desync local state from the server.

import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { ySyncPluginKey } from 'y-prosemirror'

// Transaction meta key that doc-init normalization sets on every
// transaction it dispatches. Tagged trs are exempt from the guard
// so the migration can freely add the first h1, dedup consecutive
// h1s, or strip a stray date-as-h1 on a daily doc.
//
// Exported so lib/docTitle.ts can stamp the same key.
export const SYSTEM_DOC_INIT_META = 'writerDocInit'

const titleGuardKey = new PluginKey('writer-title-guard')

function isLevel1Heading(node: { type: { name: string }; attrs: { level?: number } } | null | undefined): boolean {
  if (!node) return false
  if (node.type.name !== 'heading') return false
  return node.attrs.level === 1
}

export const titleGuardPlugin = $prose(
  () =>
    new Plugin({
      key: titleGuardKey,
      filterTransaction(tr, state) {
        // Remote (y-prosemirror sync) transactions: refusing these
        // would desync the local doc from the authoritative server
        // state. Always allow.
        if (tr.getMeta(ySyncPluginKey)) return true

        // Doc-init normalization (lib/docTitle.ts): the migration
        // legitimately needs to add or remove the first h1 to bring
        // a doc into canonical shape (insert empty h1 on first open,
        // strip stray date-h1 on dailies, dedup consecutive h1s).
        // These trs are gated by titleNormalizedV2 so they run once
        // per doc, and they are explicitly safe to apply.
        if (tr.getMeta(SYSTEM_DOC_INIT_META)) return true

        // Anything that does not touch the doc tree (selection moves,
        // inline mark toggles, decoration updates) cannot violate
        // the structural invariant. Cheap fast-path out.
        if (!tr.docChanged) return true

        // Implicit "this doc has a title slot" check: the BEFORE
        // state already starts with an h1. Daily docs render their
        // date label outside the editor and their bodies do not
        // carry a leading h1, so they fall through this check
        // naturally — the invariant does not apply to them.
        if (!isLevel1Heading(state.doc.firstChild)) return true

        // The decision: after applying this tr, does the doc still
        // start with an h1? If yes, the invariant holds. If no, the
        // tr is removing or demoting the title slot — reject.
        return isLevel1Heading(tr.doc.firstChild)
      },
    }),
)
