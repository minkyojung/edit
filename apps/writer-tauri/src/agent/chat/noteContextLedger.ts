// What each conversation has already been shown of each note's body.
//
// The open note's PATH rides every turn's user message (cheap, and the model
// must never be left guessing which note "this" means — that bug is exactly
// what this module's caller exists to fix). Its BODY is the expensive half, and
// an SDK session is append-only: there is no channel to revoke or supersede an
// earlier injection, so a body sent on turn N stays in the history for the rest
// of the conversation. Re-sending it every turn would pile up N copies of the
// same note, most of them stale.
//
// So the body goes out only when this thread hasn't already seen this exact
// content. That is a delta, and deltas are usually the wrong call here —
// Claude Code re-sends CLAUDE.md whole every turn, Aider re-sends every in-chat
// file body, both preferring the cost over a desync bug. They can: they rebuild
// the whole request each time. We can't, so the body is the one narrow
// exception, and the path stays a full resend to keep the delta surface to a
// single value.
//
// Keyed by (threadId, slug) because sessions are per-thread: what thread A has
// been shown says nothing about thread B. In-memory only — after a restart we
// re-send once, which is correct rather than merely harmless, since the model's
// view of the conversation is restored from the transcript we no longer own.

const shownByThreadSlug = new Map<string, string>()

// NUL as the separator, not a space or a colon: those can occur inside a slug,
// which would let ('t1', 'a b') and ('t1 a', 'b') collide on one entry and hand
// a thread a claim about a note it was never shown.
const SEP = '\u0000'
const key = (threadId: string, slug: string) => `${threadId}${SEP}${slug}`

/**
 * Whether `body` still needs to be shown to `threadId` for `slug` — true when
 * this thread has never been shown this note, or was shown different content.
 *
 * Pure query: call {@link markNoteBodyShown} once the body has actually been
 * committed to a prompt. Keeping the two separate matters, because the caller
 * must stamp the whole-doc CAS base (`setModelBase`) under exactly the same
 * condition — recording "the model saw this" for a body we then didn't send
 * would let a later whole-doc overwrite clobber edits the model never saw.
 */
export function needsNoteBody(threadId: string, slug: string, body: string): boolean {
  return shownByThreadSlug.get(key(threadId, slug)) !== body
}

/** Record that `threadId` has now been shown `body` for `slug`. */
export function markNoteBodyShown(threadId: string, slug: string, body: string): void {
  shownByThreadSlug.set(key(threadId, slug), body)
}

/** Drop a thread's record — call when its conversation is deleted, so a new
 * thread reusing the id can't inherit a claim about what it was shown. */
export function forgetThreadNoteContext(threadId: string): void {
  const prefix = `${threadId}${SEP}`
  for (const k of shownByThreadSlug.keys()) {
    if (k.startsWith(prefix)) shownByThreadSlug.delete(k)
  }
}

/** Test-only: reset all tracked state. */
export function __resetNoteContextLedgerForTests(): void {
  shownByThreadSlug.clear()
}
