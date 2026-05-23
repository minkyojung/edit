// Markdown assembly for ingest proposals. The single rule this
// module enforces: headings come from the host, not the model.
// Used by both the new-page body builder and the in-page accept
// flow so the two paths can't drift on formatting.

import type { IngestProposal } from './types'

/** Assemble the markdown to insert for a proposal.
 *
 * `withEntityHeading`: include `### {entity}` above the bullets.
 * - target case (append to existing page): true — the entity heading
 *   groups bullets that came from the same ingest pass.
 * - suggestNewPage case (new page is born about this entity): false —
 *   the page title already carries the topic; a body-level heading
 *   would render redundantly under it. */
export function assembleProposalMarkdown(
  proposal: Pick<IngestProposal, 'entity' | 'bullets'>,
  options: { withEntityHeading: boolean },
): string {
  const bullets = proposal.bullets
    .map((b) => b.trim())
    .filter((b) => b.length > 0)
    .map((b) => `- ${b}`)
    .join('\n')
  if (!bullets) return ''
  if (!options.withEntityHeading) return bullets
  return `### ${proposal.entity.trim()}\n${bullets}`
}
