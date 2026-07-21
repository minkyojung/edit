// Read-time base tracking for the whole-doc overwrite CAS (Layers A/D of the
// stale-overwrite fix). When we hand a note body to the model (context
// injection, @-mention), we stamp it here keyed by slug. A later whole-doc
// write compares the LIVE body at write time against this base; if they
// diverged, the user edited the note while the model was generating, and the
// write is refused as stale rather than clobbering.
//
// Mirrors Claude Code's per-file "last read state" — CAS is only meaningful
// against what the model actually saw. A slug with no recorded base (the model
// wrote to a note it was never shown) gets NO CAS, so the guard can never
// produce a false-positive block; worst case it doesn't protect (today's
// behavior).

/** How many times a single note may bounce a stale refusal back to the model
 * before we stop asking it to rebase and fall back to manual review. A user
 * typing continuously would otherwise invalidate every retry forever. */
export const MAX_STALE_RETRIES = 2

const baseBySlug = new Map<string, string>()
const staleCountBySlug = new Map<string, number>()

/** Record the body the model was shown for `slug` (the CAS base). */
export function setModelBase(slug: string, body: string): void {
  baseBySlug.set(slug, body)
}

/** The body the model was last shown for `slug`, or undefined if it was never
 * shown one (→ caller skips CAS). */
export function getModelBase(slug: string): string | undefined {
  return baseBySlug.get(slug)
}

/** Count a stale refusal for `slug`. Returns true once retries are exhausted
 * (caller should fall back to manual review instead of asking the model to
 * rebase again). */
export function bumpStale(slug: string): boolean {
  const n = (staleCountBySlug.get(slug) ?? 0) + 1
  staleCountBySlug.set(slug, n)
  return n > MAX_STALE_RETRIES
}

/** Clear the stale counter for `slug` — call on a successful apply so a later
 * legitimate race gets its full retry budget again. */
export function resetStale(slug: string): void {
  staleCountBySlug.delete(slug)
}

/** Test-only: reset all tracked state. */
export function __resetModelBaseForTests(): void {
  baseBySlug.clear()
  staleCountBySlug.clear()
}
