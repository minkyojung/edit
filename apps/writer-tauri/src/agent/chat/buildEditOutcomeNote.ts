// Feeds the model the truth about edits it proposed on a PRIOR turn but
// that never reached disk — rejected by the user, or accepted-but-failed
// to apply (stale anchor). Without this, the model keeps believing its
// `propose_edit` succeeded (the sidecar returns success immediately, by
// design, so the run doesn't stall) and may build follow-up reasoning on
// a change that isn't there.
//
// Why a follow-up PROMPT note (not a sidecar / system-prompt change):
//   The chat session lives server-side in the SDK (resume-based), and the
//   user's accept/reject happens asynchronously AFTER the proposing turn
//   ended. The only natural moment to correct the record is when the user
//   sends the NEXT message — so we fold the outcome into that turn's
//   prompt. It's turn-ephemeral, so it belongs in the user stream, not in
//   the cache-stable system blocks.
//
// The store (`pendingChangesStore`) is the single source of truth for
// every proposal's fate; this reads it and returns a HOST NOTE block plus
// the ids it covered so the caller can stamp them delivered (never told
// twice).

import { usePendingChangesStore, type PendingChange } from '@/state/pendingChangesStore'
import { useDocsStore } from '@/state/docsStore'

export interface EditOutcomeNote {
  /** Markdown block to prepend to the next user prompt, or null when
   * there's nothing undelivered to report. */
  note: string | null
  /** Ids of the changes folded into `note` — the caller stamps these
   * via `markFeedbackDelivered` once the turn is sent so the same
   * reject / failure is never reported again. */
  ids: string[]
}

/** True when a change's outcome contradicts the model's "it succeeded"
 * belief: the user rejected it, or the accept failed to write to disk. */
function didNotLand(c: PendingChange): boolean {
  if (c.status === 'rejected') return true
  if (c.status === 'accepted' && c.applyFailed) return true
  return false
}

/** Human-facing page name for a slug, mirroring the applier's commit
 * labelling: title → relPath → raw slug. */
function nameForSlug(slug: string): string {
  const doc = useDocsStore.getState().knownDocs.find((d) => d.slug === slug)
  return doc?.title?.trim() || doc?.relPath || slug
}

/** Collect the not-yet-delivered non-landing outcomes for `threadId` and
 * render them as a prompt-prefix note. Ingest proposals carry no
 * `threadId`, so they're naturally excluded — this is chat-only. */
export function buildEditOutcomeNote(threadId: string): EditOutcomeNote {
  const pending = usePendingChangesStore.getState().byId
  const relevant = Object.values(pending).filter(
    (c) =>
      c.context.threadId === threadId &&
      c.feedbackDeliveredAt === null &&
      didNotLand(c),
  )
  if (relevant.length === 0) return { note: null, ids: [] }

  const lines = relevant.map((c) => {
    const name = nameForSlug(c.pageSlug)
    const reason = c.reason?.trim()
    const label = reason ? `\`${name}\` ("${reason}")` : `\`${name}\``
    const outcome =
      c.status === 'rejected'
        ? 'rejected by the user'
        : 'could not be applied (the text it targeted had changed)'
    return `- ${label}: ${outcome} — your change is NOT in the file.`
  })

  const note = [
    '[HOST NOTE — outcomes of edits you proposed earlier in this conversation.',
    'This is a system message, NOT something the user typed.]',
    'Some edits you proposed did not end up in the files:',
    ...lines,
    'Do not assume these edits were saved. Re-read the relevant file before',
    'proposing any follow-up edit that depends on them.',
  ].join('\n')

  return { note, ids: relevant.map((c) => c.id) }
}
