/**
 * Markdown export — public types for the Level 3 export feature.
 *
 * Ported from the validated prototype at `.context/prototype-git-storage/`
 * (90% mark-survival roundtrip benchmark, see prototype RESULTS.md). The
 * shapes here are kept Level-4-compatible so a future two-way sync layer
 * can read what we wrote without a schema migration.
 *
 * Two on-disk artifacts per page:
 *   - `<slug>.md`             — clean markdown body (no inline mark spans)
 *   - `<slug>.marks.json`     — sidecar metadata, schema below
 *
 * Marks live in the sidecar (not in the .md) so external editors like
 * Obsidian render the body unmodified; the mark layer reattaches when the
 * page comes back into our editor via semantic anchor (quote + context),
 * mirroring proof-sdk's own `resolveQuote()` fallback chain.
 */

export type MarkKind =
  | 'authored'
  | 'approved'
  | 'flagged'
  | 'comment'
  | 'insert'
  | 'delete'
  | 'replace'
  | 'provenance'

export type ResolutionStatus = 'confident' | 'degraded' | 'orphaned'

/**
 * Semantic anchor — how a mark locates itself in the text after a roundtrip
 * through an external editor.
 *
 * `quote` is the exact text the mark covered at export time.
 * `contextBefore` / `contextAfter` disambiguate when `quote` appears
 * multiple times in the body. `occurrence` is the 0-indexed ordinal used
 * when context matching also can't pin it down (typically duplicated
 * paragraphs with no distinguishing nearby text).
 */
export interface AnchorSpec {
  quote: string
  contextBefore: string
  contextAfter: string
  occurrence: number
}

/**
 * One entry in the `.marks.json` sidecar.
 *
 * `attrs` carries kind-specific fields (by, sourceSlug, model, etc.) and
 * stays opaque to the anchor resolver — only `anchor` is read at import.
 * Keeping attrs as a free-form record lets us evolve mark metadata
 * (proof-sdk adds new fields to authored/provenance over time) without
 * breaking previously-exported sidecars.
 */
export interface MarkSidecar {
  id: string
  kind: MarkKind
  attrs: Record<string, string | null | undefined>
  anchor: AnchorSpec
}

/**
 * The full `.marks.json` payload.
 *
 * `version: 1` is the current schema. A future Level 4 (two-way sync)
 * extension will bump this and add a `migrate(from)` step at the import
 * boundary — existing v1 sidecars will keep working untouched.
 */
export interface MarksSidecarFile {
  version: 1
  marks: MarkSidecar[]
}

/**
 * Output of a serialize step: the two strings we'd write side-by-side.
 *
 * The serializer is pure — it produces strings in memory; the Tauri
 * fs-plugin handler is the only place that actually touches disk. Keeping
 * them split lets tests assert exact bytes without filesystem dependence.
 */
export interface SerializedDoc {
  md: string
  sidecar: MarksSidecarFile
}

/**
 * Per-mark resolution result after deserialize + resolve.
 *
 * `range` is null when status is 'orphaned'. The mark id is preserved either
 * way so the caller can show "this mark lost its anchor".
 */
export interface ResolvedMark {
  id: string
  kind: MarkKind
  attrs: Record<string, string | null | undefined>
  status: ResolutionStatus
  range: { from: number; to: number } | null
  /** Echo of the original anchor — useful for orphaned UX (show user
   * what we were looking for). */
  anchor: AnchorSpec
}

/**
 * Full deserialize output: the document plain text + per-mark resolution.
 *
 * `plainText` is the markdown-parsed text (not a PM doc); resolved ranges
 * are char offsets into it. The wrapping flow turns this back into a real
 * PM doc + Y.Doc when importing.
 */
export interface DeserializedDoc {
  plainText: string
  marks: ResolvedMark[]
}
