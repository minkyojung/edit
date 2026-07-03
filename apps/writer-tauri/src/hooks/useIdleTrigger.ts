// Daily ingest trigger — file durable facts from the user's daily journal
// into the wiki.
//
// Karpathy's LLM wiki pattern is "user drops a source, tells the LLM to
// process it" — a deliberate, user-initiated event. Daily ingest is now
// PULL-only: the sidebar Sync button (syncTodayManually) runs ONE pass against
// today's daily through the general intake agent (processDailyNote), which
// proposes wiki edits into the standard approval queue. There is no auto timer
// or boot catch-up — an agentic pass per day isn't worth firing unprompted.
//
// Mounted once at app root via useIdleTrigger() (name kept for the call site)
// purely to sweep stale proposals on boot.

import { useEffect } from 'react'
import { processDailyNote } from '@/agent/dailyIngest'
import { useDocsStore, isWikiDoc } from '@/state/docsStore'
import { useIngestStore } from '@/state/ingestStore'
import { effectiveLength } from '@/lib/markdownText'
import { todayLocalDate } from '@/hooks/useDocMeta'
import { extractErrorCode } from '@/chat/utils/errorMessage'
import { notify } from '@/lib/notify'
import { useConnectDialog } from '@/stores/connectDialog'
import { getActiveVaultPath, getInboxAutoOrganize } from '@/state/settingsStore'

interface RunOptions {
  /** Skip the dirty-bit gate. Used by the manual Sync button / dev hooks so a
   * tester can force a pass even when the note hasn't changed since last sync. */
  force?: boolean
}

/** Effective length of the doc's body, client-side, from the `bodyMarkdown`
 * cache. Returns 0 when no handle exists (treated as "nothing to ingest"). */
function readDocLength(slug: string): number {
  const docs = useDocsStore.getState()
  const handle = docs.handles[slug]
  if (!handle) return 0
  return effectiveLength(handle.bodyMarkdown)
}

/** Run a daily ingest pass against a specific note slug via the general intake
 * agent, which proposes wiki edits into the pending-changes queue. Returns the
 * proposal count (0 if skipped/empty, -1 on error). Callers arrange the
 * single-flight guarding at the trigger site. */
async function runIngestForSlug(slug: string, opts: RunOptions = {}): Promise<number> {
  const docs = useDocsStore.getState()
  const known = docs.knownDocs.find((d) => d.slug === slug)
  if (!known) return 0
  // Agent-managed pages (system:* + wiki:*) are LLM output, not input —
  // ingesting one would feed the wiki's content back into itself.
  if (isWikiDoc(known)) return 0
  if (known.archivedAt) return 0

  const length = readDocLength(slug)
  if (length === 0) return 0

  if (!opts.force) {
    // Dirty-bit gate: re-ingest only if the note has been edited since the
    // last successful pass. `lastEditedAt` is bumped on any change;
    // `markIngested` stamps `lastIngestedAt` on success. First ingest (no
    // prior `lastIngestedAt`) always falls through.
    const ingest = useIngestStore.getState()
    const editedAt = ingest.lastEditedAt[slug] ?? 0
    const ingestedAt = ingest.lastIngestedAt[slug] ?? 0
    if (ingestedAt > 0 && editedAt <= ingestedAt) return 0
  }

  let result
  try {
    result = await processDailyNote(slug)
  } catch (err) {
    console.warn('[ingest] daily ingest failed', slug, err)
    // AUTH always surfaces — no future pass can succeed until the user
    // reconnects. Other errors surface only on a manual trigger (the user
    // just clicked Sync and expects feedback); auto paths stay silent.
    if (extractErrorCode(err) === 'AUTH') {
      notify.claudeSessionExpired({
        onReconnect: () => useConnectDialog.getState().setOpen(true),
      })
    } else if (opts.force) {
      notify.wikiSyncFailed()
    }
    return -1
  }

  // Note-level dedup: stamp this note as ingested so an unedited note isn't
  // re-run. The agent staged any wiki edits into the pending-changes queue
  // itself — nothing to materialize here.
  useIngestStore.getState().markIngested(slug)
  return result.editCount
}

/** Find today's daily entry in the catalog. Returns null when it hasn't been
 * bootstrapped yet (rare) or has been archived. */
function findTodayDaily(): { slug: string } | null {
  const today = todayLocalDate()
  const docs = useDocsStore.getState()
  const found = docs.knownDocs.find(
    (d) => d.type === 'daily' && d.date === today && !d.archivedAt,
  )
  return found ? { slug: found.slug } : null
}

/** Manual sync entry point — resolves today's daily and runs one ingest pass
 * against it. The sidebar Sync button calls this. Returns the proposal count
 * (0 when nothing new), or null when there's no daily to target. */
export async function syncTodayManually(): Promise<number | null> {
  const today = findTodayDaily()
  if (!today) {
    console.log('[ingest:sync] no today daily to target')
    return null
  }
  return runIngestForSlug(today.slug, { force: true })
}

/** Fire after this many ms of no user input — "the user paused". Long enough
 * that it doesn't interrupt active work, short enough to feel prompt. */
const IDLE_MS = 60_000

/** Single-flight guard: never overlap two idle passes (an agentic run can take
 * seconds; a second idle tick mid-run would double up). Module-level so it
 * survives re-renders / remounts. */
let idleRunning = false

/** One idle organize pass. Gated three ways so an unprompted run is cheap and
 * opt-out-able: a vault must be open, the setting must be on, and no pass may
 * already be in flight. `autoOrganizeInbox` itself is a no-op when the inbox
 * has nothing new, so the common idle tick costs nothing. Imported lazily to
 * avoid a static import cycle (organize.ts imports syncTodayManually from here). */
async function runIdleOrganize(): Promise<void> {
  if (idleRunning) return
  if (!getActiveVaultPath()) return
  if (!getInboxAutoOrganize()) return
  idleRunning = true
  try {
    const { autoOrganizeInbox } = await import('@/agent/organize')
    const { processed, moves } = await autoOrganizeInbox()
    if (processed > 0) console.log('[idle] auto-organized inbox notes:', processed)
    // Surface the auto-applied moves (they have no review card). Skipped when
    // nothing moved — a pass that only staged wiki proposals shows its cards.
    if (moves.length > 0) notify.inboxOrganized(moves)
  } catch (err) {
    console.warn('[idle] auto-organize failed', err)
  } finally {
    idleRunning = false
  }
}

/** Mounted once near the app root. Arms an inactivity timer: after {@link
 * IDLE_MS} of no user input, run one inbox organize pass (same job as the
 * manual Organize button, inbox-only + dedup'd). Any input re-arms the timer,
 * so the pass only fires while the user is paused — never mid-keystroke. The
 * daily-ingest path stays pull-only (the Sync button); this only automates the
 * inbox, and only when the setting is on. */
export function useIdleTrigger(): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const arm = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void runIdleOrganize(), IDLE_MS)
    }
    const events: (keyof WindowEventMap)[] = [
      'mousemove',
      'mousedown',
      'keydown',
      'wheel',
      'touchstart',
      'focus',
    ]
    events.forEach((e) => window.addEventListener(e, arm, { passive: true }))
    arm() // start the first countdown on mount
    return () => {
      if (timer) clearTimeout(timer)
      events.forEach((e) => window.removeEventListener(e, arm))
    }
  }, [])
}

// Dev-only console hooks. __triggerIdle / __syncToday both hit today's daily
// (same as the manual Sync button) so existing test workflows keep working.
if (import.meta.env.DEV) {
  const w = window as unknown as {
    __triggerIdle: () => Promise<number | null>
    __syncToday: () => Promise<number | null>
  }
  w.__triggerIdle = syncTodayManually
  w.__syncToday = syncTodayManually
}
