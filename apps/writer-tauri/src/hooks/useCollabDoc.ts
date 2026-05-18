// Types-only module — the original single-doc `useCollabDoc()` hook
// was retired when the multi-doc store (`docsStore`) took over handle
// lifecycle. Several files still import the shared types from here so
// the file remains as a pure type surface; the runtime hook + its
// 'My Document' default-title bootstrap are gone.
import type * as Y from 'yjs'
import type { IndexeddbPersistence } from 'y-indexeddb'

export type CollabStatus = 'loading' | 'ready' | 'error'

export type StoredMarkStatus = 'pending' | 'accepted' | 'rejected'
export type MarkKind =
  | 'authored'
  | 'approved'
  | 'flagged'
  | 'comment'
  | 'insert'
  | 'delete'
  | 'replace'
  | 'provenance'

export interface StoredMark {
  id?: string
  kind: MarkKind
  by?: string
  at?: string
  quote?: string
  range?: { from: number; to: number }
  startRel?: string
  endRel?: string
  content?: string
  status?: StoredMarkStatus
  text?: string
  resolved?: boolean
  orphaned?: boolean
  note?: string
  // Provenance fields — populated when kind === 'provenance'. The
  // mark is a permanent breadcrumb for LLM-origin text that the user
  // accepted (proofSuggestion → provenance on accept) or that was
  // seeded directly into a freshly-created wiki page. Hover UI reads
  // these to answer "where did this sentence come from?" without the
  // text needing a visible underline.
  sourceQuote?: string
  sourceSlug?: string
  sourceLabel?: string
  createdAt?: string
  /** @deprecated Legacy alias for createdAt — older entries may still
   * carry this key. Readers fall through createdAt → proposedAt → at. */
  proposedAt?: string
  acceptedAt?: string
  model?: string
}

export interface CollabHandle {
  ydoc: Y.Doc
  slug: string
  /** Client-side IndexedDB persistence layer. Will be removed in Path C
   * Step 3b — for the transitional window we keep it as a fallback
   * surface alongside the vault-driven `contentReady`. */
  idb: IndexeddbPersistence
  /** @deprecated Use {@link CollabHandle.contentReady}. Kept while
   * Step 3a migrates callers; removed in 3b with the IDB layer. */
  idbSynced: Promise<void>
  /** Resolves once the doc's body + marks have been hydrated into the
   * ydoc. Sources, in order of authority:
   *   1. The vault file (.md + .marks.json)  ← Path C primary
   *   2. (legacy) IDB cache, until Step 3b removes it
   *   3. Empty (for brand-new docs with no on-disk file yet)
   *
   * Callers that need to read/write content-dependent state (editor
   * binding, mark application, dirty-bit observers) should await this
   * instead of `idbSynced`. */
  contentReady: Promise<void>
}

/**
 * Per-authored-mark metadata, keyed by mark id in Y.Map('authoredMeta').
 *
 * The inline anchor is a `proofAuthored` mark (carries id + by);
 * the rich provenance fields (sourceSlug / sourceLabel / acceptedAt /
 * model) ride in this sibling Y.Map keyed by the same mark id. Split
 * this way so the mark schema stays minimal — adding new metadata
 * fields doesn't require a schema migration.
 *
 * Wire shape:
 *   ydoc.getMap<AuthoredMeta>('authoredMeta').set(markId, { ... })
 *
 * Lifecycle: written when acceptMark stamps the authored mark; read
 * by markHoverPlugin (footer breadcrumb) and EditorFooter (the
 * "X% AI" stat sums chars covered by authored marks regardless of
 * whether they carry meta or not). Cleared by markCleanupPlugin
 * when the inline anchor disappears (deletion / overtype), same as
 * Y.Map('marks').
 */
export interface AuthoredMeta {
  /** Wiki page slug the AI sentence came from, if any. Null for
   * suggestions that weren't sourced from another doc. */
  sourceSlug?: string
  /** Human-readable label for the source wiki page. */
  sourceLabel?: string
  /** The exact quoted span from the source page. */
  sourceQuote?: string
  /** ISO timestamp when the AI first proposed this text. */
  createdAt?: string
  /** ISO timestamp when the user accepted it. */
  acceptedAt?: string
  /** Model identifier (e.g., 'claude-opus-4-7'). */
  model?: string
}
