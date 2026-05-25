// Types-only module — the original single-doc `useCollabDoc()` hook
// was retired when the multi-doc store (`docsStore`) took over handle
// lifecycle. Several files still import the shared types from here so
// the file remains as a pure type surface; the runtime hook + its
// 'My Document' default-title bootstrap are gone.
//
// The `StoredMark` / `AuthoredMeta` / `MarkKind` types that used to
// live here were retired in Phase 6 of the Yjs-removal migration
// alongside the mark store / hooks that consumed them. The PM-level
// proof-mark schema (editor/schema/proof-marks.ts) is unrelated and
// stays in place for legacy `.md` round-tripping.

import type * as Y from 'yjs'

export type CollabStatus = 'loading' | 'ready' | 'error'

export interface CollabHandle {
  ydoc: Y.Doc
  slug: string
  /** Resolves once the doc's body has been hydrated. Sources, in order:
   *   1. The vault `.md` file (via applyVaultBodyToYDoc + a parallel
   *      read into `bodyMarkdown` — Phase 5a of the Yjs-removal
   *      migration)
   *   2. Empty (for brand-new docs with no on-disk file yet — the
   *      auto-flush pipeline writes the first version on the next tick)
   *
   * Callers that need to read content-dependent state await this
   * before touching `bodyMarkdown` or the ydoc fragment. Phase 5c will
   * retire the ydoc; the contentReady gate moves with `bodyMarkdown`. */
  contentReady: Promise<void>
  /** Markdown snapshot taken at hydrate time. Phase 5a of the Yjs-
   * removal migration: the editor reads this as its
   * `defaultValueCtx` seed (no Y.Doc fragment hydrate), and the three
   * inactive-doc fragment readers (ingest/readDoc, useIdleTrigger,
   * wikiService) fall back to it when no PM view is mounted. Updated
   * on:
   *   - initial vault load (buildHandle)
   *   - external reload (handlesSlice.reloadFromVault)
   *   - background body rewrite (createSlice.seed/replaceDocBody when
   *     `activeViewForSlug` returns null)
   * Active-view writes go through `applyMarkdownToEditor` instead;
   * `flushDirty` then rewrites the `.md` and updates this cache on the
   * next round. */
  bodyMarkdown: string
}
