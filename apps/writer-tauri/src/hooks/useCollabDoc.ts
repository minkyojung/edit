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
