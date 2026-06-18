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
  /** Phase G: the LLM produces final markdown directly. Host writes
   * this string into the target page (after a wikilink-syntax
   * safety pass). Formatting rules — entity heading, bullet shape,
   * provenance footer — live in the vault-root CLAUDE.md and the
   * LLM is expected to follow them. Replaces the atomic
   * entity/bullets pair from earlier versions, which forced
   * host-side wrapping that duplicated the page title heading
   * ("### Sera" under a "Sera" page) on every ingest. */
  markdownToAppend: string
  /** Short reason the LLM gave for proposing this. Optional —
   * surfaced in the inline review widget's secondary line so the
   * user can judge the routing at a glance. */
  rationale?: string
  /** The exact daily-line snippet this content was derived from,
   * echoed verbatim. Provenance + dedup: the user can see "where
   * in my note did this come from", and the host may hash it to
   * recognise re-suggestions of the same fact even if the LLM
   * worded the markdown differently. Optional because some
   * proposals legitimately stand on aggregated context. */
  sourceQuote?: string
}

export interface IngestResult {
  /** Append-only edits the LLM thinks the wiki should reflect. */
  proposals: IngestProposal[]
  /** Deprecated. The host now writes `_system/log.md` automatically
   * (one row per applied proposal, formatted from data the host
   * already has). Kept in the schema for backward compat with older
   * LLM emissions; readers should ignore. */
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
   * straight from the source file / URL. For chat-handoff this is
   * the assistant message body. */
  text: string
  /** Free-form label used in the user prompt (`daily/YYYY-MM-DD`
   * for daily, `imported/<file>` for bootstrap, `chat: <title>` for
   * chat handoff). Surfaces as the provenance string the LLM cites
   * in its proposals; the prompt builder also branches on the
   * `chat:` prefix to tighten extraction. */
  sourceLabel: string
  /** Optional prompt-builder overrides. Default to the wiki-ingest
   * prompts (composeSystemPrompt / buildPrompt). The inbox router
   * injects its own variant — knowledge→wiki proposals,
   * action/interpretation/event→daily entries — without forking the
   * LLM-call choreography in runIngestCore. */
  composeSystem?: (args: {
    claudeMd: string
    selfProfile: string
  }) => string[]
  buildUser?: (args: {
    date: string
    noteLabel: string
    noteMarkdown: string
  }) => string
}

export interface IngestCoreResult {
  proposals: IngestProposal[]
  logEntry: string | null
  raw: string
  malformed: boolean
}
