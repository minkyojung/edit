// Adapter from ingest's IngestProposal shape to the unified
// pendingChangesStore's PendingChange shape.
//
// One IngestProposal becomes one PendingChange with a single
// PendingEdit carrying the assembled `### {entity}\n- {bullet}\n...`
// markdown block. Keeping each entity as one staged change matches
// the LLM's atomic unit (one entity = one proposal in its tool
// output) and the user's natural decision unit ("do I want this fact
// on this page or not?") — the inline review UI in Phase C surfaces
// one card per entity, not one per bullet.
//
// All proposals from a single ingest pass share one `groupId` so the
// user can later batch-reject a whole pass (Phase C's "reject this
// ingest" banner / Review Panel bulk action).

import type { IngestProposal } from './types'
import type { PendingChange } from '@/state/pendingChangesStore'

export interface MapProposalArgs {
  /** A proposal post-materialise — `target` is guaranteed populated
   * (suggestNewPage was rewritten to a real wiki:custom-<id> by
   * `materializeNewPageProposals` upstream). */
  proposal: IngestProposal & { target: string }
  /** The doc slug the proposal lands on. Resolved from `target`
   * (type id) against `knownDocs` by the caller. */
  pageSlug: string
  /** Stable id shared across every PendingChange in the same ingest
   * pass — enables batch-reject of an entire pass. */
  groupId: string
  /** Where this proposal came from — `daily/YYYY-MM-DD` or the source
   * note's title. Surfaces in the Review Panel timeline. */
  sourceLabel: string
  /** Slug of the source note (e.g. today's daily). Optional — used
   * by the inline review UI to render "from daily/..." provenance. */
  sourceSlug?: string
}

/** Produce a PendingChange shape ready to push into the store. The
 * caller mints the id (so chat / ingest can use their own correlation
 * tokens — sidecar's pendingId for chat, a fresh UUID for ingest). */
export function mapIngestProposalToPendingChange(
  args: MapProposalArgs,
  changeId: string,
  editId: string,
): Omit<PendingChange, 'status' | 'decidedAt' | 'viewedAt'> {
  // Phase G: the LLM already produced final markdown per the
  // CLAUDE.md formatting rules; we stash it verbatim. The inline
  // review widget renders it as-is so the user sees exactly what
  // will land on disk if accepted.
  const markdown = args.proposal.markdownToAppend

  return {
    id: changeId,
    source: 'ingest',
    pageSlug: args.pageSlug,
    groupId: args.groupId,
    createdAt: Date.now(),
    edits: [
      {
        id: editId,
        kind: 'add',
        // Anchor "append to end of page" — the empty string is the
        // documented sentinel for "no preceding context, paste at
        // the doc's tail". Phase C's PM decoration plugin resolves
        // this to the actual PM position at render time so a
        // concurrent edit elsewhere in the doc doesn't shift the
        // staged change.
        anchorBefore: '',
        after: markdown,
      },
    ],
    context: {
      sourceSlug: args.sourceSlug,
      rationale: args.proposal.rationale,
      sourceQuote: args.proposal.sourceQuote,
    },
  }
}
