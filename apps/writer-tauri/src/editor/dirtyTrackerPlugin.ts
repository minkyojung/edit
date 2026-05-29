// PM-native dirty bit tracker.
//
// Why this exists:
//   The doc-file flush loop (`flushDirty` in lib/docFileSync.ts) walks a
//   slug set populated by `markSlugDirty` and writes the PM-derived
//   markdown to disk. Before the Yjs-removal migration, that set was
//   populated by a Y.XmlFragment observer installed on the doc's
//   Y.Doc — y-prosemirror's collab plugin mirrored every PM transaction
//   into the fragment, which fired the observer, which marked the slug
//   dirty. Phase 3 of the migration retired the collab plugin and broke
//   that chain: PM edits no longer reach Y.Doc, the fragment observer
//   never fires, and `flushDirty` sleeps forever while the on-disk file
//   freezes at boot-time content.
//
//   This plugin is the standard PM replacement for that hook (the same
//   shape `docVersionPlugin.ts` uses to broadcast doc revisions). The
//   plugin's `view().update(view, prevState)` callback runs after every
//   transaction; comparing `view.state.doc !== prevState.doc` filters
//   out selection-only transactions, and a hit calls `markSlugDirty`
//   so the next flush tick picks the slug up.
//
// Slug binding:
//   The slug is captured at plugin-construction time. MilkdownEditor
//   builds one plugin instance per `handle.slug`, so a doc switch
//   tears down the old plugin (editor unmount → editor.destroy) and
//   builds a fresh one with the new slug. No global slug lookup; the
//   plugin doesn't need to know which doc is currently active.
//
// What this plugin does NOT do:
//   - Trigger flushes itself. That's still the auto-flush timer's job
//     (every FLUSH_INTERVAL_MS), or any explicit `flushDirty()` caller.
//   - Mirror PM state into Y.Doc. Phases 5–7 retire Y.Doc; until then
//     Y.Doc stays as the boot-seed snapshot and nothing depends on it
//     reflecting live edits.

import { $prose } from '@milkdown/kit/utils'
import { Plugin } from '@milkdown/kit/prose/state'
import { markSlugDirty } from '@/lib/docFileSync'
import { stripPendingFromDoc } from '@/lib/stripPendingFromDoc'
import { useEditorViewStore } from '@/state/editorViewStore'
import { useDocsStore } from '@/state/docsStore'

/** Build a PM plugin that:
 *   1. Flags `slug` dirty on every content-changing transaction.
 *   2. Mirrors the serialized markdown back into `handle.bodyMarkdown`
 *      so the in-memory cache is always fresh — surviving editor
 *      unmount and unblocking the flush path from its "active doc
 *      only" gate.
 *
 * Phase I rationale: post-Yjs the flush path used to serialize from
 * the live PM doc, which evaporated the moment the editor unmounted.
 * Mirroring per-transaction makes `handle.bodyMarkdown` the canonical
 * in-memory source of truth — `flushDirty` reads from it without
 * needing the editor to still be alive. */
export function createDirtyTrackerPlugin(slug: string) {
  return $prose(
    () =>
      new Plugin({
        view: () => ({
          update: (view, prevState) => {
            if (view.state.doc === prevState.doc) return
            markSlugDirty(slug)
            // Serialize once per content-changing transaction and stash
            // on the handle. The cost is one markdown serialize per
            // keystroke at editor speed — same cost the auto-flush
            // would pay every 500ms anyway, just moved up to the
            // source of truth.
            const { serializer } = useEditorViewStore.getState()
            if (!serializer) return
            try {
              // Strip pending-insert regions before serializing: pending
              // add content lives in the live doc as real nodes (for
              // NodeView-faithful rendering) but must never reach disk
              // until Keep. This is the single serialization choke point
              // (see stripPendingFromDoc). No-op when no pending marks
              // exist — returns the same doc reference.
              const md = serializer(stripPendingFromDoc(view.state.doc))
              const handle = useDocsStore.getState().handles[slug]
              if (handle) handle.bodyMarkdown = md
            } catch (err) {
              console.warn('[dirtyTracker] serialize failed', slug, err)
            }
          },
        }),
      }),
  )
}
