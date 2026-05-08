// Idle-trigger ingest — Karpathy "Memories" pattern. While the user
// types we stay completely out of the way; only after they step
// away (mouse / keyboard / focus all quiet for `idleMinutes`) does
// the wiki bookkeeper wake up, read what's new, and queue proposals
// for review.
//
// Mounted once at app root via `useIdleTrigger()`. Holds a single
// timer; activity events reset it. When the timer fires it ingests
// the active doc (and only the active doc — the user's most recent
// focus is the most natural unit, matches Karpathy's "ingest one
// source at a time" style and avoids parallel sidecar load).
//
// Watermark gate: an ingest pass marks the doc's body length, and
// subsequent passes skip unless the body has grown by at least
// MIN_GROWTH chars. Editing-and-deleting the same paragraph twice
// shouldn't burn tokens; meaningful new content does.

import { useEffect, useRef } from 'react'
import { runIngest } from '@/agent/ingest'
import { useDocsStore } from '@/state/docsStore'
import { useIngestStore } from '@/state/ingestStore'
import { ensureLogWikiSlug } from '@/state/wikiService'
import { todayLocalDate } from '@/hooks/useDocMeta'

const PROOF_BASE_URL = 'http://localhost:4000'
/** Minimum new chars since last ingest before the trigger will run
 * again on the same doc. Keeps short edits / typo fixes from
 * burning Haiku calls — the wiki only cares about substantive
 * additions. Tuned at 200 chars ≈ a short paragraph. */
const MIN_GROWTH = 200
/** Throttle window for mousemove handling. mousemove fires per
 * pixel of motion; without this the listener pegs a CPU on idle
 * trigger reset thrash. 1s is invisible to humans but spares the
 * timer hot-path. */
const MOUSEMOVE_THROTTLE_MS = 1000

interface RunOptions {
  /** Skip the watermark gate. Used by the dev console hook
   * `__triggerIdle()` so a tester can force a pass without typing
   * 200 chars first. */
  force?: boolean
}

/** Read a doc's markdown via the canonical proof-server route.
 * Returns '' on failure so the watermark check treats unreachable
 * docs as "no growth" and skips them silently. */
async function readDocLength(slug: string): Promise<number> {
  try {
    const res = await fetch(
      `${PROOF_BASE_URL}/documents/${encodeURIComponent(slug)}`,
    )
    if (!res.ok) return 0
    const json = (await res.json()) as { markdown?: string }
    const md = (json.markdown ?? '').replace(/[​\s]/g, '')
    return md.length
  } catch {
    return 0
  }
}

/** Run an ingest pass against the currently active note. Returns
 * the number of proposals enqueued (0 if skipped or empty). Wrapped
 * in a singleton guard at the call site so two timers can't fire
 * concurrent passes on the same doc. */
async function runActiveIngest(opts: RunOptions = {}): Promise<number> {
  const docs = useDocsStore.getState()
  const activeSlug = docs.activeSlug
  if (!activeSlug) return 0
  const activeKnown = docs.knownDocs.find((d) => d.slug === activeSlug)
  if (!activeKnown) return 0

  // Pick the doc to ingest FROM. Active doc is the user's most
  // recent focus, so it's the natural default — except wiki pages,
  // which are the agent's output: ingesting one would feed the
  // wiki's own content back into itself. Falling back to today's
  // daily covers the common pattern where the user writes in the
  // daily, opens a wiki page to review the result, then walks away;
  // without this fallback the idle trigger would silently no-op on
  // their daily's new content.
  let slug = activeSlug
  let known = activeKnown
  if (activeKnown.type.startsWith('wiki:')) {
    const today = todayLocalDate()
    const todayDaily = docs.knownDocs.find(
      (d) => d.type === 'daily' && d.date === today && !d.archivedAt,
    )
    if (!todayDaily) return 0
    slug = todayDaily.slug
    known = todayDaily
  }
  if (known.archivedAt) return 0

  const length = await readDocLength(slug)
  if (length === 0) return 0

  if (!opts.force) {
    const ingest = useIngestStore.getState()
    const watermark = ingest.lastIngestedLength[slug] ?? 0
    if (length - watermark < MIN_GROWTH) return 0
  }

  let result
  try {
    result = await runIngest(slug)
  } catch (err) {
    console.warn('[ingest] runIngest failed', slug, err)
    return 0
  }
  // Update the watermark unconditionally on a successful call —
  // even an empty proposal set means "we looked at this length and
  // judged nothing notable", and re-asking on the same content
  // would be wasted tokens.
  useIngestStore.getState().markIngested(slug, length)

  if (result.malformed) {
    console.warn('[ingest] malformed response, skipping enqueue', result.raw)
    return 0
  }
  if (result.proposals.length === 0 && !result.logEntry) return 0

  // wiki:log is the only system-owned wiki page and is created
  // lazily on first need. Without this, a logEntry would queue but
  // never drain because the target doc wouldn't exist in the
  // catalog for the user to navigate to.
  if (result.logEntry) {
    await ensureLogWikiSlug()
  }

  const sourceLabel =
    known.type === 'daily' && known.date
      ? `daily/${known.date}`
      : known.title?.trim() || slug
  useIngestStore.getState().enqueue({
    proposals: result.proposals,
    logEntry: result.logEntry,
    sourceSlug: slug,
    sourceLabel,
  })
  return result.proposals.length
}

/** Mounts the idle trigger. Call once near the app root. Reads
 * `idleMinutes` from the ingest store on every reset so a settings
 * change takes effect on the next idle window without remounting. */
export function useIdleTrigger(): void {
  // Hold the timer in a ref so each effect cycle can clear and
  // restart it without re-binding all DOM listeners. A single
  // timer + a single set of listeners across the hook's lifetime
  // is the lightest setup.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Single-flight guard: keeps a second timer-fire from kicking off
  // a parallel runActiveIngest while the first is still in flight.
  // The lock auto-releases in the finally block.
  const runningRef = useRef(false)
  // Last mousemove handled. mousemove fires per pixel; we throttle
  // to MOUSEMOVE_THROTTLE_MS to stop the timer-reset hot path from
  // chewing CPU when the cursor drifts.
  const lastMoveRef = useRef(0)

  useEffect(() => {
    const reset = () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      const minutes = useIngestStore.getState().idleMinutes
      timerRef.current = setTimeout(() => {
        if (runningRef.current) return
        runningRef.current = true
        void runActiveIngest()
          .catch((err) => console.warn('[ingest] idle pass failed', err))
          .finally(() => {
            runningRef.current = false
            // Don't auto-restart the timer here — we wait for the
            // user's next bit of activity. Otherwise a fully idle
            // browser would loop forever burning calls on the same
            // doc (the watermark blocks it, but the call itself
            // still fires).
          })
      }, minutes * 60_000)
    }

    const onActivity = () => reset()
    const onMove = (e: MouseEvent) => {
      void e
      const now = Date.now()
      if (now - lastMoveRef.current < MOUSEMOVE_THROTTLE_MS) return
      lastMoveRef.current = now
      reset()
    }

    // Start the first window the moment the hook mounts so a user
    // who immediately walks away gets an ingest pass — no need to
    // touch the keyboard once first.
    reset()

    window.addEventListener('keydown', onActivity)
    window.addEventListener('focus', onActivity)
    window.addEventListener('click', onActivity)
    window.addEventListener('mousemove', onMove)

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      window.removeEventListener('keydown', onActivity)
      window.removeEventListener('focus', onActivity)
      window.removeEventListener('click', onActivity)
      window.removeEventListener('mousemove', onMove)
    }
  }, [])
}

// Dev-only console hook so a tester can fire an ingest immediately
// without waiting `idleMinutes` and without typing 200 chars. Skips
// the watermark; otherwise identical to the timer path.
if (import.meta.env.DEV) {
  ;(window as unknown as { __triggerIdle: () => Promise<number> }).__triggerIdle =
    () => runActiveIngest({ force: true })
}
