import type { ChatTurn } from '@/chat/types'
import type { QueuedTurn } from '@/stores/turnState'

/** The order the transcript renders in: settled history, then the answer being
 * written, then anything typed while it was writing.
 *
 * The last two being in that order is the whole reason queued turns are kept out
 * of the settled list. Settled turns come from Yjs and always sort before
 * `streamingTurn`, so a queued message committed to that list on send landed
 * ABOVE the answer still being generated — mid-transcript, while the user was
 * watching the bottom. It read as the message having been swallowed.
 *
 * Extracted rather than inlined in ChatPanel because that is the only way this
 * ordering is under test: the panel has no render-interaction harness here, and
 * reversing the last two terms — the exact original bug — otherwise leaves the
 * whole suite green. */
export function composeTranscript(
  turns: ChatTurn[],
  streamingTurn: ChatTurn | null,
  queued: QueuedTurn[],
): ChatTurn[] {
  const out = streamingTurn ? [...turns, streamingTurn] : [...turns]
  for (const q of queued) out.push(q.turn)
  return out
}
