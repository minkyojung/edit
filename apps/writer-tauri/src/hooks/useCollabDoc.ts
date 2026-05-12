// Types-only module — the original single-doc `useCollabDoc()` hook
// was retired when the multi-doc store (`docsStore`) took over handle
// lifecycle. Several files still import the shared types from here so
// the file remains as a pure type surface; the runtime hook + its
// 'My Document' default-title bootstrap are gone.
import type * as Y from 'yjs'
import type { HocuspocusProvider } from '@hocuspocus/provider'

export type CollabStatus = 'initializing' | 'connecting' | 'connected' | 'error'

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
  provider: HocuspocusProvider
  slug: string
}

/**
 * Per-authored-mark metadata, keyed by mark id in Y.Map('authoredMeta').
 *
 * Background: proof-server only canonicalizes the seven mark kinds
 * it ships with (authored / approved / flagged / comment / insert /
 * delete / replace). Our old `proofProvenance` mark was a custom
 * kind layered on top to carry wiki-source breadcrumbs + accept
 * timestamps; the server didn't recognize it, so its HTML→markdown
 * projection mangled spans carrying that mark, which the drift
 * detector then read as a projection wipe and reverted the accept.
 * The split-tr workaround in markActions.ts was a defensive
 * sequencing trick to dodge that — never a proper fix.
 *
 * The portable path is to use the standard `proofAuthored` mark for
 * the inline anchor (server understands it, single-tr accept stays
 * safe) and park the extra metadata in a sibling Y.Map keyed by the
 * same mark id. Yjs syncs the Y.Map as opaque binary, so the server
 * never has to parse it — drift detection can't fire on metadata
 * the server doesn't read.
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
