// "Organize" — the single user-facing entry point that files content into the
// wiki/daily via the general intake agent. Orchestrates the per-source runners
// (daily ingest, inbox intake) so the UI has one verb instead of three.
//
// Runs are SERIAL: each source is one agentic runIntake pass, so firing them
// concurrently would fan out N expensive runs at once. One at a time keeps the
// cost bounded and the approval queue readable.

import { useDocsStore } from '@/state/docsStore'
import { processInboxNote } from '@/agent/inbox'
import { processDailyNote } from '@/agent/dailyIngest'
import { syncTodayManually } from '@/hooks/useIdleTrigger'

export interface OrganizeResult {
  /** Notes actually handed to the agent (skips gated-out / empty ones). */
  processed: number
  /** Total proposals staged into the approval queue across all notes. */
  proposals: number
}

/** Default action: organize today's daily, then every inbox note — serially. */
export async function organizeTodayAndInbox(): Promise<OrganizeResult> {
  let processed = 0
  let proposals = 0

  // Today's daily first (gated — skips silently if unchanged since last sync).
  try {
    const daily = await syncTodayManually()
    if (daily != null) {
      processed += 1
      proposals += Math.max(0, daily)
    }
  } catch (err) {
    console.warn('[organize] daily failed', err)
  }

  // Then each inbox capture, one at a time. Duplicate-skipping is the agent's
  // job (it reads the target wiki page before proposing).
  const inbox = useDocsStore
    .getState()
    .knownDocs.filter((d) => d.relPath?.startsWith('inbox/') && !d.archivedAt)
  for (const note of inbox) {
    try {
      const r = await processInboxNote(note.slug)
      processed += 1
      proposals += r.editCount
    } catch (err) {
      console.warn('[organize] inbox note failed', note.slug, err)
    }
  }

  return { processed, proposals }
}

/** Organize a single note (the one open in the editor). A daily note routes
 * through the daily prompt (facts → wiki, never edits the daily itself); any
 * other note routes through the inbox prompt (facts → wiki, actions → daily). */
export async function organizeNote(slug: string): Promise<number> {
  const known = useDocsStore.getState().knownDocs.find((d) => d.slug === slug)
  const result =
    known?.type === 'daily'
      ? await processDailyNote(slug)
      : await processInboxNote(slug)
  return result.editCount
}
