// The tool-result message handed back to the model when a whole-doc write is
// refused as stale (Layer A of the stale-overwrite fix). It rides the existing
// edit-ack `reason` channel, which the sidecar's PostToolUse hook already turns
// into a model-visible "(error: …)" retry signal — so no new relay channel is
// needed. The message must give the model enough to rebase WITHOUT a separate
// re-read (which the model can't do for a body only held in the editor): the
// changed lines plus the current body inline.

import type { LineRange } from '@/lib/bodyStale'

/** Cap the inline body so a large note doesn't blow the turn's token budget;
 * the changed-line hint still points the model at what moved. */
const MAX_INLINE_BODY = 6000

function formatRanges(ranges: LineRange[]): string {
  if (ranges.length === 0) return 'unknown lines'
  return ranges
    .map((r) => (r.from === r.to ? `${r.from}` : `${r.from}-${r.to}`))
    .join(', ')
}

export function buildStaleReason(
  filePath: string,
  changedLines: LineRange[],
  latest: string,
): string {
  const body =
    latest.length > MAX_INLINE_BODY
      ? `${latest.slice(0, MAX_INLINE_BODY)}\n…(truncated — read the file for the rest)`
      : latest
  return (
    `${filePath} changed since you read it — line(s) ${formatRanges(changedLines)} ` +
    `differ from the version you wrote against. Do NOT resubmit your previous ` +
    `version; it would discard the user's edits. Rewrite against the current ` +
    `content below and call the write tool again:\n\n${body}`
  )
}
