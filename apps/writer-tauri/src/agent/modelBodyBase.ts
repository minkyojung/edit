// Read-time base tracking for the whole-doc overwrite CAS (Layers A/D of the
// stale-overwrite fix). When we hand a note body to the model (context
// injection, @-mention), we stamp it here. A later whole-doc write compares the
// LIVE body at write time against this base; if they diverged, the note changed
// under the model while it was generating, and the write is refused as stale
// rather than clobbering.
//
// Mirrors Claude Code's per-file "last read state" — CAS is only meaningful
// against what the model actually saw. A note with no recorded base (the model
// wrote to one it was never shown) gets NO CAS, so the guard can never produce
// a false-positive block; worst case it doesn't protect (today's behavior).
//
// Keyed by (threadId, slug) in lockstep with the note-context ledger, which
// decides when a body is sent at all. Slug alone is not enough: two
// conversations editing one note each hold their own claim about what they were
// shown, and judging one against the other's is precisely the silent clobber
// this module exists to prevent. Thread — not run — because the ledger
// suppresses re-sending an unchanged body on later turns of the same
// conversation, so a per-run base would simply be absent from turn two onward
// and the CAS would quietly stop running.

/** How many times a single note may bounce a stale refusal back to the model
 * before we stop asking it to rebase and fall back to manual review. A user
 * typing continuously would otherwise invalidate every retry forever. */
export const MAX_STALE_RETRIES = 2

const baseByThreadSlug = new Map<string, string>()
const staleCountByThreadSlug = new Map<string, number>()

// NUL as the separator, not a space or a colon: those can occur inside a slug,
// which would let ('t1', 'a b') and ('t1 a', 'b') collide on one entry and judge
// a conversation's write against a body it was never shown.
const SEP = '\u0000'
const key = (threadId: string, slug: string) => `${threadId}${SEP}${slug}`

/** Record the body `threadId` was shown for `slug` (the CAS base). */
export function setModelBase(threadId: string, slug: string, body: string): void {
  baseByThreadSlug.set(key(threadId, slug), body)
}

/** The body `threadId` was last shown for `slug`, or undefined if it was never
 * shown one (→ caller skips CAS). */
export function getModelBase(threadId: string, slug: string): string | undefined {
  return baseByThreadSlug.get(key(threadId, slug))
}

/** Count a stale refusal for `threadId`'s writes to `slug`. Returns true once
 * retries are exhausted (caller should fall back to manual review instead of
 * asking the model to rebase again). */
export function bumpStale(threadId: string, slug: string): boolean {
  const k = key(threadId, slug)
  const n = (staleCountByThreadSlug.get(k) ?? 0) + 1
  staleCountByThreadSlug.set(k, n)
  return n > MAX_STALE_RETRIES
}

/** Clear the stale counter — call on a successful apply so a later legitimate
 * race gets its full retry budget again. */
export function resetStale(threadId: string, slug: string): void {
  staleCountByThreadSlug.delete(key(threadId, slug))
}

/** Drop a thread's bases and counters — call when its conversation is deleted.
 * These hold whole note bodies, so without this the map grows for every
 * (thread, note) pair the app ever chats about and never shrinks. */
export function forgetThreadModelBase(threadId: string): void {
  const prefix = `${threadId}${SEP}`
  for (const k of baseByThreadSlug.keys()) {
    if (k.startsWith(prefix)) baseByThreadSlug.delete(k)
  }
  for (const k of staleCountByThreadSlug.keys()) {
    if (k.startsWith(prefix)) staleCountByThreadSlug.delete(k)
  }
}

/** Test-only: reset all tracked state. */
export function __resetModelBaseForTests(): void {
  baseByThreadSlug.clear()
  staleCountByThreadSlug.clear()
}
