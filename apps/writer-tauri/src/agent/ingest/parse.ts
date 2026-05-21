// Semantic validation + sanitisation for the model's
// `submit_ingest_result` tool payload. The zod schema in the sidecar
// already guarantees field shape; this layer enforces cross-field
// invariants the schema can't express (e.g. "must have target or
// suggestNewPage").

import type { IngestProposal } from './types'

/** Raw shape the sidecar relays from the model's
 * `submit_ingest_result` tool call. Field types mirror the zod
 * schema in sidecar/src/server.mjs — the SDK has already validated
 * shape by the time this lands, so the only work left is semantic
 * (sanitizeIngestResult below). */
export interface IngestToolInput {
  proposals: Array<{
    target?: string
    suggestNewPage?: string
    /** Legacy field — accepted for backward compatibility with a
     * previous schema generation but ignored at sanitize time. Wiki
     * is now flat; nesting under a parent isn't a concept the model
     * needs to reason about. */
    suggestNewPageParent?: string
    entity: string
    bullets: string[]
    rationale?: string
    sourceQuote?: string
  }>
  logEntry: string | null
}

export interface ParsedIngest {
  proposals: IngestProposal[]
  logEntry: string | null
}

/** Semantic filtering on top of the tool's structural validation.
 *
 * The zod schema guarantees field shape and required-ness, but a
 * few invariants are cross-field or domain-specific and can't be
 * expressed there:
 *
 *   - a proposal must have at least one of `target` / `suggestNewPage`;
 *     both empty means "nowhere to land", drop it.
 *   - when both are set, prefer `target` (less destructive — uses an
 *     existing page rather than spawning a new one).
 *   - `suggestNewPageParent` is now stripped — the wiki is flat,
 *     parent nesting isn't part of the data model.
 *
 * Whitespace trimming for free-form strings stays here too —
 * harmless and keeps the apply layer free of "is this empty?" gymnastics. */
export function sanitizeIngestResult(input: IngestToolInput): ParsedIngest {
  const proposals: IngestProposal[] = []
  for (const p of input.proposals) {
    const target = p.target?.trim() || undefined
    const suggestNewPage = p.suggestNewPage?.trim() || undefined
    if (!target && !suggestNewPage) continue
    // p.suggestNewPageParent intentionally ignored — see file header.
    // Zod guarantees entity is a non-empty string and bullets is a
    // non-empty array, but the model can still ship whitespace-only
    // values inside those slots. Trim + filter here so the apply
    // layer never sees an entity that's just spaces or a bullet
    // that would render as a blank `-`. A proposal that ends up
    // with zero usable bullets is dropped — same policy the old
    // shape applied to empty `content`.
    const entity = p.entity.trim()
    const bullets = p.bullets
      .map((b) => b.trim())
      .filter((b) => b.length > 0)
    if (!entity || bullets.length === 0) continue
    proposals.push({
      ...(target ? { target } : { suggestNewPage: suggestNewPage! }),
      entity,
      bullets,
      rationale: p.rationale,
      sourceQuote: p.sourceQuote?.trim() || undefined,
    })
  }

  const logEntry = input.logEntry?.trim() || null

  return { proposals, logEntry }
}
