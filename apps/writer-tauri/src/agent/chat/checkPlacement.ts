// Does this proposal actually fit the document it targets — and if not, why?
//
// Run in the chat listener just before a PendingChange is pushed, so the model
// learns the outcome from its own tool result (the round-trip added in the
// propose_edit fix) instead of inferring it from a file that staging leaves
// deliberately unchanged.
//
// Deliberately NOT inside `push`: a future ingest path must not inherit this
// check retroactively. The chat listener is the one caller that has a model
// waiting on an answer.
//
// The policy is Claude Code's, adapted to staging — three outcomes, not two:
//   - the text is there                → proceed
//   - there's nothing to do            → proceed, reported as success
//   - absent / ambiguous               → refuse, and say which, with the
//                                        document's current content inline
// Reporting "nothing to do" as a failure is the one mistake that cannot
// self-correct: the model re-reads, sees the text already correct, proposes the
// same edit, and is refused again.

import { placeEdits } from '@/editor/cmHunks'
import type { Placement } from '@/lib/editPlacement'
import { useDocsStore } from '@/state/docsStore'
import { readDocBody } from '@/state/docsStore/docBody'
import type { PendingEdit } from '@/state/pendingChangesStore'

export type EditCheck = { ok: true } | { ok: false; reason: string }

/** How much of the current document to quote back. Enough for the model to
 * rebase without a second Read (the pattern propose_write's stale path already
 * proved out), bounded so a large note can't dominate the context. */
const QUOTE_LIMIT = 4000

function quoteBody(body: string): string {
  return body.length <= QUOTE_LIMIT
    ? body
    : `${body.slice(0, QUOTE_LIMIT)}\n… (truncated; Read the file for the rest)`
}

/** Turn a refusal into the sentence the model acts on. The two failures need
 * opposite advice, which is the whole reason `Placement` distinguishes them:
 * an absent anchor means "look at what's actually there", an ambiguous one
 * means "you found it several times, narrow it down". */
export function describeRefusal(placement: Placement, label: string, body: string, editCount: number): string {
  // MultiEdit applies as one transaction, so name the offending edit the way
  // the built-in tool does — otherwise the model has to guess which of its
  // edits to fix.
  const which = editCount > 1 && 'editIndex' in placement ? `(edit #${placement.editIndex + 1}) ` : ''
  if (placement.kind === 'ambiguous') {
    return (
      `${which}the text you targeted matches more than one place in ${label}, so it is ` +
      `ambiguous — the host never guesses which occurrence you meant. Include enough ` +
      `surrounding lines to make it unique, then propose the edit again.`
    )
  }
  return (
    `${which}the text you targeted is not in ${label}. Its current content is below — ` +
    `rebase onto this and propose the edit again. Do not resubmit the same old_string.\n\n` +
    quoteBody(body)
  )
}

/** Check a mapped change against the LIVE body of the doc it targets.
 *
 * FAIL OPEN on anything that leaves us without a document to check against.
 * `readDocBody` answers '' for a note that was never opened, and chat edits
 * usually DO target closed notes — so a check that treated that as "anchor
 * absent" would refuse most legitimate edits. Hydrating first is what makes the
 * check usable at all; when even that doesn't produce a body, saying nothing
 * beats saying something false.
 *
 * Deliberately does NOT fall back to reading disk. Disk and the live buffer
 * disagree by design while a proposal is staged, and reintroducing the disk read
 * here would re-create the very split this change exists to remove. */
export async function checkEditPlacement(
  pageSlug: string,
  change: { edits: PendingEdit[] },
  label: string,
): Promise<EditCheck> {
  // A check that adjudicates and a check that fails open look IDENTICAL from
  // outside when the edit was fine anyway — which is the common case. Without
  // this line there is no way to tell a working check from one that silently
  // punts on every call, and the second is indistinguishable from not having
  // built it. Logged in DEV only; the refusal path below logs unconditionally,
  // being a consequential decision.
  const trace = (outcome: string) => {
    if (import.meta.env.DEV) console.log('[placement]', outcome, label)
  }
  let body: string
  try {
    await useDocsStore.getState().ensureHandle(pageSlug)
    const handle = useDocsStore.getState().handles[pageSlug]
    // Same outcome as falling through — `undefined.contentReady` throws and the
    // catch below returns ok — so no test can tell this line from its absence.
    // Kept because arriving at the right answer via a TypeError is an accident,
    // not a policy, and the next edit to that catch could quietly end it.
    if (!handle) {
      trace('open:no-handle')
      return { ok: true }
    }
    await handle.contentReady
    body = readDocBody(pageSlug)
  } catch {
    trace('open:hydration-failed')
    return { ok: true }
  }
  // An empty body is indistinguishable from a hydration that quietly produced
  // nothing, so it is not evidence the anchor is missing.
  if (!body) {
    trace('open:empty-body')
    return { ok: true }
  }

  const { placement } = placeEdits(body, change)
  if (placement.kind === 'ok' || placement.kind === 'noop') {
    trace(`checked:${placement.kind}`)
    return { ok: true }
  }
  console.warn('[placement] refused', placement.kind, label, {
    target: placement.target,
    editIndex: placement.editIndex,
  })
  return { ok: false, reason: describeRefusal(placement, label, body, change.edits.length) }
}
