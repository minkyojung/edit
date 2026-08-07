// The compare-and-swap decision for an auto-accepted whole-doc write, split out
// of the edit-pending handler so the policy is unit-testable without the event
// plumbing (the repo pattern — cf. materializeChatNewWikiPage). The handler
// interprets the returned outcome: apply+accept, bounce a stale verdict back to
// the model via the ack, or park for manual review.

import { applyWriteWikiPageChecked } from '@/agent/applyIngest'
import { getModelBase, setModelBase, bumpStale, resetStale } from '@/agent/modelBodyBase'
import { buildStaleReason } from '@/agent/staleFeedback'

export type WholeDocWriteOutcome =
  /** Live body matched the base (or none recorded) — the write landed; accept it. */
  | { kind: 'applied' }
  /** Live body diverged from what the model wrote against — refused. Feed
   * `ackReason` (the latest body inline) back to the model so it rebases; leave
   * the change pending so the user's edit survives. */
  | { kind: 'stale'; ackReason: string }
  /** Stale too many times (a user who keeps typing) — stop asking the model to
   * rebase; leave the change pending for manual review. */
  | { kind: 'parked' }
  /** Hard failure (no handle / hydrate / unresolved external conflict). */
  | { kind: 'failed' }

/**
 * Attempt an auto-accepted whole-doc overwrite under compare-and-swap. Advances
 * the model's base on success (so its OWN follow-up write this turn doesn't read
 * as a divergence) and counts stale refusals toward the retry cap. Pure w.r.t.
 * the caller: returns an outcome, performs no accept/ack/notify itself.
 */
export async function guardedWholeDocWrite(
  threadId: string,
  slug: string,
  body: string,
  changeId: string,
  filePath: string,
): Promise<WholeDocWriteOutcome> {
  const res = await applyWriteWikiPageChecked(
    slug,
    body,
    getModelBase(threadId, slug),
    changeId,
  )
  if (res.ok) {
    setModelBase(threadId, slug, body)
    resetStale(threadId, slug)
    return { kind: 'applied' }
  }
  if (res.reason === 'stale') {
    if (bumpStale(threadId, slug)) return { kind: 'parked' }
    // Advance the base to the latest body — the exact content we now hand the
    // model to rebase against. Without this the resubmit's CAS still compares
    // the live body to the ORIGINAL base (which diverged, or it wouldn't have
    // been stale), so every rebase re-stales and the model's change can never
    // land. We advance to `latest` (what the model rewrites against), NOT to the
    // rejected `body` (which never touched disk).
    setModelBase(threadId, slug, res.stale.latest)
    return {
      kind: 'stale',
      ackReason: buildStaleReason(filePath, res.stale.changedLines, res.stale.latest),
    }
  }
  return { kind: 'failed' }
}
