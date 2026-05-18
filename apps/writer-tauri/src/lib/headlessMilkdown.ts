// Headless Milkdown — app-wide parser / serializer singleton.
//
// Why this exists (Path C Step 3c):
//   The markdown parser and serializer are technically properties of a
//   Milkdown Editor instance, but they're functionally independent of
//   any specific document — given the same schema-affecting plugin set,
//   they produce identical output. Building ONE ghost Editor at app
//   boot and exposing its parser/serializer globally means doc-loading
//   code (applyVaultToHandle, ingest seeding, backfill) can convert
//   markdown ↔ PM without waiting for a per-doc MilkdownEditor mount.
//
// What this replaces:
//   Previously MilkdownEditor.tsx populated useEditorViewStore.parser /
//   .serializer on its first mount (after `await contentReady`). That
//   created a chicken-and-egg: vault load — which runs inside the
//   contentReady chain — needed the parser, but the parser was set
//   AFTER contentReady resolved. With IDB as a fallback the cycle was
//   invisible (body came from IDB regardless); Path C removed IDB and
//   the cycle surfaced as "body stays empty even though .md is on disk".
//
// The ghost editor pattern (vs a true headless API):
//   Milkdown 7.x doesn't ship an explicit headless export. The standard
//   pattern is to create a normal Editor with a DETACHED div as root —
//   plugins register, the parser/serializer ctxs populate, but nothing
//   renders to the visible DOM since the root is never appended. This
//   is what every disk-backed Milkdown integration uses for export /
//   import pipelines.
//
// Plugin selection:
//   Only schema-affecting plugins are included. PM-behavior plugins
//   (mark deco, wikilink palette, etc.) don't change parser output and
//   are skipped — keeping the headless instance lean and avoiding
//   plugins that depend on per-doc state (collab, ydoc-bound mark
//   plugins). The set matches MilkdownEditor.tsx for the parts that
//   matter, and any future schema plugin must be added BOTH here AND
//   there to keep them aligned.

import {
  Editor,
  editorViewOptionsCtx,
  parserCtx,
  rootCtx,
  serializerCtx,
} from '@milkdown/kit/core'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import { listItemBlockComponent } from '@milkdown/kit/component/list-item-block'
import { configureListItemBlock } from '@/editor/listItemConfig'
import { proofSchemaPlugins } from '@/editor/proofMarks'
import { useEditorViewStore } from '@/state/editorViewStore'

let initPromise: Promise<void> | null = null
// Module-level array (not just a local) so the editor instance stays
// reachable for the app's lifetime — its plugin internals (parser
// closure over schema, serializer closure over toMarkdown runners)
// would be GC-collected if the only ref dropped. The array is never
// read; its purpose is reachability.
const ghostEditorRefs: Editor[] = []

/** Build the ghost Milkdown editor and publish its parser / serializer
 * into editorViewStore. Idempotent + concurrency-safe — the promise
 * is cached so concurrent callers share one boot.
 *
 * Resolves once parser + serializer are in the store. Reject only on
 * Editor.create() failure (rare — would mean a plugin throw at boot).
 *
 * Call once during app startup, before any code that depends on the
 * markdown parser. After this resolves, useEditorViewStore.getState()
 * .parser and .serializer are guaranteed non-null until app exit. */
export function initHeadlessParser(): Promise<void> {
  if (initPromise) return initPromise

  initPromise = (async () => {
    // Detached root — never appended to document.body, never rendered.
    // The editor instance still constructs its EditorView under the
    // hood (some plugins assume one exists at create() time), but it
    // operates on this orphan element with no visible effect.
    const ghostRoot = document.createElement('div')
    const editor = await Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, ghostRoot)
        ctx.set(editorViewOptionsCtx, { attributes: {} })
      })
      .config(configureListItemBlock)
      .use(commonmark)
      .use(gfm)
      .use(listItemBlockComponent)
      // proofSchemaPlugins (5 marks + code_block extension + frontmatter)
      // must be present so parsing inline marks the user / AI inserted
      // (proofSuggestion, proofComment, proofAuthored, etc.) doesn't
      // crash on unknown mark types. Same registration order as the
      // main editor — marks first, code_block_ext after.
      .use(proofSchemaPlugins)
      .create()

    ghostEditorRefs.push(editor)
    editor.action((ctx) => {
      const parser = ctx.get(parserCtx)
      const serializer = ctx.get(serializerCtx)
      useEditorViewStore.getState().setParser(parser)
      useEditorViewStore.getState().setSerializer(serializer)
    })
  })().catch((err) => {
    // Clear so a retry is possible after the underlying issue is
    // fixed (e.g. a plugin update).
    initPromise = null
    ghostEditorRefs.length = 0
    console.error('[headless milkdown] init failed', err)
    throw err
  })

  return initPromise
}
