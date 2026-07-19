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
  /** In-memory body mirror. The editor reads this as its mount-time hydrate
   * source, and the inactive-doc readers fall back to it when no editor is
   * mounted. `readonly` here: it may ONLY be written through the body-write
   * owner `state/docsStore/docBody.ts` (updateDocBody / setBodyMirror), which
   * makes the read-modify-write atomic. A raw `handle.bodyMarkdown = …`
   * anywhere else is a compile error (and an ESLint error) by design — that
   * scattered-writer pattern is what caused the past silent-save-loss bugs. */
  readonly bodyMarkdown: string
  /** Per-handle teardown. Runs vault-sync disposer + clears the
   * slug's dirty flag. Idempotent — closeDoc / archiveDoc each call
   * it once when a handle leaves the catalog. */
  destroy: () => void
}
