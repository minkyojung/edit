// Public types for the ingest pipeline. Pure declarations — no
// imports beyond other types — so any module in the codebase can
// depend on these without dragging in the engine wiring.

/** A single proposed wiki edit. v1 = append-only (the LLM may not
 * modify or delete existing lines). Routing has two flavors:
 *
 *   • `target` — append to an existing wiki page by its type id.
 *   • `suggestNewPage` — no existing page fits; ask the system to
 *     create a new one with the given display name and stamp the
 *     content there. The apply layer creates the page eagerly and
 *     rewrites the proposal's target to the new doc's type id, so
 *     downstream code only ever sees `target`.
 *
 * Exactly one of `target` or `suggestNewPage` is expected. If both
 * are present validateParsed prefers `target` (less destructive
 * fallback); if neither, the proposal is rejected. */
export interface IngestProposal {
  /** wiki:* type id (e.g. 'wiki:entity', 'wiki:custom-7nt...'). */
  target?: string
  /** Display name for a brand-new page the LLM wants to create
   * because no existing page is a good home for this content. The
   * apply layer turns this into a real `wiki:custom-<id>` page. */
  suggestNewPage?: string
  /** Topic the bullets are about — e.g. a person's name, a book
   * title, a project. Used as the `### {entity}` sub-heading when
   * appending to an existing `target` page; ignored when creating
   * a `suggestNewPage` (the page title is the topic). */
  entity: string
  /** Bullet bodies the model wants to record under `entity`. Plain
   * text — no leading `-`, no nested markdown structure. The host
   * assembles the final `### {entity}\n- {b}\n...` shape at apply
   * time. Splitting `content: string` into this atomic shape is
   * what blocks the model from re-emitting page-level headers
   * (e.g. "## People") that doubled up on every accept. */
  bullets: string[]
  /** Short reason the LLM gave for proposing this. Optional. */
  rationale?: string
  /** The exact daily-line snippet this content was derived from,
   * echoed verbatim. Provenance: lets the user (and the review
   * card) see "where in my note did this fact come from?" — so
   * mis-routes (e.g. Alex content sent to a Chris page because
   * the LLM mismapped a name) are visible at a glance instead of
   * buried inside the wiki body. Optional because some proposals
   * legitimately stand on aggregated context, not a single line. */
  sourceQuote?: string
}

export interface IngestResult {
  /** Append-only edits the LLM thinks the wiki should reflect. */
  proposals: IngestProposal[]
  /** Pre-formatted log line for wiki:log, or null if nothing was
   * meaningful enough to log. Format follows Karpathy's convention:
   * `## [YYYY-MM-DD] <kind> | <summary>`. */
  logEntry: string | null
  /** Raw assistant text for debugging. Useful when JSON parsing
   * fails so we can see what the model actually returned. */
  raw: string
  /** True when the assistant emitted text but it didn't parse as
   * JSON. Caller can show a soft warning rather than treating as
   * a hard error. */
  malformed: boolean
  /** Full snapshot of the source note's block hashes at the moment
   * this pass ran. Caller persists into
   * ingestStore.ingestedBlockHashes so the next pass can filter
   * already-seen blocks out before reaching the LLM. Empty when
   * the pass short-circuited before reading the note (unknown
   * doc, empty body, etc.); callers should skip the persist call
   * in that case to avoid clobbering a valid prior snapshot. */
  ingestedHashes: string[]
}

/** Shape passed to `runIngestCore` — the lower-level engine entry
 * point used by both the daily-driven runIngest path and the
 * bootstrap importer. Bootstrap can't use runIngest directly
 * because it doesn't have a doc slug or a block-hash watermark.
 *
 * Returned shape mirrors `IngestResult` minus `ingestedHashes`,
 * which is daily-only state (bootstrap doesn't dedup by hash). */
export interface IngestCoreArgs {
  /** Already-filtered text to feed the model. For daily this is the
   * concatenated body of new blocks; for bootstrap it's a raw chunk
   * straight from the source file / URL. */
  text: string
  /** Free-form label used in the user prompt (`daily/YYYY-MM-DD`
   * for daily, `imported/<file>` for bootstrap). Surfaces as the
   * provenance string the LLM cites in its proposals. */
  sourceLabel: string
  /** Chat-thread watermark for `selectActiveThreadsForIngest`.
   * Daily passes `lastIngestedAt[slug]`; bootstrap passes 0 so the
   * first run sees every thread. */
  sinceTs: number
  /** Doc slug whose threads should contribute to the chat-activity
   * block. Each thread's `parentSlug` is matched against this. Pass
   * null to omit chat activity (bootstrap before any doc opens). */
  threadSlug: string | null
}

export interface IngestCoreResult {
  proposals: IngestProposal[]
  logEntry: string | null
  raw: string
  malformed: boolean
}
