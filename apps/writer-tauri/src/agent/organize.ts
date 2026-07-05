// "Organize" — the single user-facing entry point that files content into the
// wiki/daily via the general intake agent. Orchestrates the per-source runners
// (daily ingest, inbox intake) so the UI has one verb instead of three.
//
// Runs are SERIAL: each source is one agentic runIntake pass, so firing them
// concurrently would fan out N expensive runs at once. One at a time keeps the
// cost bounded and the approval queue readable.

import { useDocsStore } from '@/state/docsStore'
import { useIngestStore } from '@/state/ingestStore'
import { useGitStore, aiEditSubject } from '@/state/gitStore'
import { getDefaultNoteFolder } from '@/state/settingsStore'
import { processInboxNote } from '@/agent/inbox'
import { syncTodayManually } from '@/hooks/useIdleTrigger'
import type { OrganizeRequest } from '@/state/pendingOrganizeStore'

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

  // Then each capture-folder note, one at a time. Duplicate-skipping is the
  // agent's job (it reads the target wiki page before proposing). The capture
  // folder is the configured one (settings), not a hardcoded 'inbox', so a
  // renamed folder keeps working.
  const capturePrefix = getDefaultNoteFolder() + '/'
  const inbox = useDocsStore
    .getState()
    .knownDocs.filter((d) => d.relPath?.startsWith(capturePrefix) && !d.archivedAt)
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

/** Idle auto-organize: process only the inbox captures that haven't been filed
 * yet, one at a time. Same per-note runner as the manual Organize button
 * (processInboxNote → wiki/daily edits + move_note), but scoped and gated for
 * an UNPROMPTED pass:
 *  - inbox-only — the daily journal is the user's own writing, never touched
 *    without a click;
 *  - dedup'd — a note is stamped ingested after its pass, so one the agent
 *    chose to leave (unsure where it belongs) isn't re-run every idle tick;
 *    a successfully filed note is moved OUT of the inbox by the agent, so it
 *    drops off the list naturally.
 * Returns the count handed to the agent plus the notes that actually moved
 * (detected by a changed relPath) so the caller can surface the otherwise-
 * invisible move. Both empty when the inbox has nothing new — the common,
 * free case. */
export async function autoOrganizeInbox(): Promise<{
  processed: number
  moves: { from: string; to: string }[]
}> {
  const capturePrefix = getDefaultNoteFolder() + '/'
  const ingest = useIngestStore.getState()
  const fresh = useDocsStore.getState().knownDocs.filter((d) => {
    if (!d.relPath?.startsWith(capturePrefix) || d.archivedAt) return false
    const ingestedAt = ingest.lastIngestedAt[d.slug] ?? 0
    const editedAt = ingest.lastEditedAt[d.slug] ?? 0
    return ingestedAt === 0 || editedAt > ingestedAt
  })

  let processed = 0
  const moves: { from: string; to: string }[] = []
  for (const note of fresh) {
    const before = note.relPath
    try {
      await processInboxNote(note.slug)
      useIngestStore.getState().markIngested(note.slug)
      processed += 1
      // The agent auto-moves a filed note out of the inbox via move_note; detect
      // it by the relPath the host rewrote (moveDocToFolder) during the run.
      const after = useDocsStore.getState().knownDocs.find((d) => d.slug === note.slug)?.relPath
      if (before && after && after !== before) moves.push({ from: before, to: after })
    } catch (err) {
      console.warn('[organize:idle] inbox note failed', note.slug, err)
    }
  }
  // Checkpoint the auto-applied moves as one revertible commit. The pass's
  // wiki proposals stay pending (not on disk) until the user Keeps them, so
  // this commit contains exactly the moves. commitChangesNow flushes +
  // serializes + is empty-safe.
  if (moves.length > 0) {
    // Name each move `<note> → <dest folder>` so the checkpoint reads at a
    // glance (and the undo skill can match "undo the organize of X").
    const names = moves.map((m) => {
      const base = m.from.split('/').pop() ?? m.from
      const destDir = m.to.slice(0, m.to.lastIndexOf('/')) || m.to
      return `${base} → ${destDir}`
    })
    await useGitStore.getState().commitChangesNow(aiEditSubject('organize', names))
  }
  return { processed, moves }
}

/** Build the organize request for a single note (the one open in the editor),
 * so it can run as a *visible* chat thread instead of headless. A daily note
 * routes through the daily prompt (facts → wiki, never edits the daily itself);
 * any other note routes through the inbox prompt (facts → wiki, actions →
 * daily). The kickoff mirrors the headless runners' (processDailyNote /
 * processInboxNote) so the chat path and the bulk path read the same way.
 * Returns null on an unknown slug. */
export async function buildOrganizeNoteRequest(
  slug: string,
): Promise<Omit<OrganizeRequest, 'threadId'> | null> {
  const known = useDocsStore.getState().knownDocs.find((d) => d.slug === slug)
  if (!known) return null
  const isDaily = known.type === 'daily'
  const relPath =
    known.relPath ??
    (isDaily && known.date ? `daily/${known.date}.md` : `${slug}.md`)
  const title = `Organize ${known.title || relPath}`

  // Native: send the plugin command as the (visible) user turn; the SDK expands
  // its body (routing brain) and substitutes `$ARGUMENTS` = the note path. Empty
  // systemPrompt — the brain lives in the command, not a persona block.
  if (isDaily) {
    return { systemPrompt: '', prompt: `/daily-ingest ${relPath}`, title }
  }
  return { systemPrompt: '', prompt: `/organize ${relPath}`, title }
}
