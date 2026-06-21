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

import { processDailyNote } from '@/agent/dailyIngest'
import { useDocsStore, isWikiDoc } from '@/state/docsStore'
import { getActiveSlugFromHash } from '@/lib/viewUrl'
import { useEditorViewStore } from '@/state/editorViewStore'
import { useIngestStore } from '@/state/ingestStore'
import { effectiveLength } from '@/lib/markdownText'
import { todayLocalDate } from '@/hooks/useDocMeta'
import { extractErrorCode } from '@/chat/utils/errorMessage'
import { notify } from '@/lib/notify'
import { useConnectDialog } from '@/stores/connectDialog'

interface RunOptions {
  /** Skip the dirty-bit gate. Used by the manual Sync button / dev hooks so a
   * tester can force a pass even when the note hasn't changed since last sync. */
  force?: boolean
}

/** Effective length of the doc's body, client-side. Reads from the live PM doc
 * when the slug is active, otherwise from the `bodyMarkdown` cache. Returns 0
 * when no handle exists (treated as "nothing to ingest"). */
function readDocLength(slug: string): number {
  const docs = useDocsStore.getState()
  const handle = docs.handles[slug]
  if (!handle) return 0
  if (getActiveSlugFromHash() === slug) {
    const view = useEditorViewStore.getState().view
    if (view) return effectiveLength(view.state.doc.textContent)
  }
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

/** Mounted once near the app root. Daily ingest is pull-only now (the Sync
 * button → syncTodayManually), so there is nothing to do on mount; the hook is
 * kept as a no-op for the existing call site. */
export function useIdleTrigger(): void {
  // No-op: the auto timer / boot catch-up were removed. Kept so App.tsx's
  // call site stays valid; remove both together if desired.
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
