// Types-only module — the original single-doc `useCollabDoc()` hook
// was retired when the multi-doc store (`docsStore`) took over handle
// lifecycle. Several files still import the shared types from here so
// the file remains as a pure type surface; the runtime hook + its
// 'My Document' default-title bootstrap are gone.
//
// Phase 5c of the Yjs-removal migration retired the `ydoc: Y.Doc`
// field from `CollabHandle`. The handle is now a pure markdown +
// lifecycle bag: `bodyMarkdown` is the in-memory body cache and
// `destroy()` runs the per-handle cleanup (vault-sync disposer)
// that used to piggy-back on `ydoc.destroy()`.

export type CollabStatus = 'loading' | 'ready' | 'error'

export interface CollabHandle {
  slug: string
  /** Resolves once the doc's body has been hydrated from the vault
   * `.md` file into `bodyMarkdown`. Brand-new docs with no on-disk
   * file resolve with an empty string and the auto-flush pipeline
   * writes the first version on the next tick.
   *
   * Callers that need to read content-dependent state await this
   * before touching `bodyMarkdown`. */
  contentReady: Promise<void>
  /** Markdown snapshot taken at hydrate time. The editor reads this
   * as its mount-time hydrate source, and the three inactive-doc
   * readers (ingest/readDoc, useIdleTrigger, wikiService) fall back
   * to it when no PM view is mounted. Updated on:
   *   - initial vault load (buildHandle)
   *   - external reload (handlesSlice.reloadFromVault)
   *   - background body rewrite (createSlice.seed/replaceDocBody when
   *     no PM view is mounted for this slug)
   * Active-view writes go through `applyMarkdownToEditor` and then
   * `flushDirty` rewrites the `.md` and updates this cache on the
   * next round. */
  bodyMarkdown: string
  /** Per-handle teardown. Runs vault-sync disposer + clears the
   * slug's dirty flag. Idempotent — closeDoc / archiveDoc each call
   * it once when a handle leaves the catalog. */
  destroy: () => void
}
