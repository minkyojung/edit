// "Organize" — files inbox captures into the wiki/daily via the general intake
// agent. The idle trigger calls autoOrganizeInbox on a cadence; that's the only
// entry point now (the manual editor-menu actions were removed).
//
// Runs are SERIAL: each note is one agentic runIntake pass, so firing them
// concurrently would fan out N expensive runs at once. One at a time keeps the
// cost bounded and the approval queue readable.

import { useDocsStore } from '@/state/docsStore'
import { useIngestStore } from '@/state/ingestStore'
import { useGitStore, aiEditSubject } from '@/state/gitStore'
import { getDefaultNoteFolder } from '@/state/settingsStore'
import { getActiveSlugFromHash } from '@/lib/viewUrl'

/** Don't auto-file a capture edited within this window — the user only just
 * paused on it (the idle trigger fires at 60s of inactivity), so treat it as
 * still in-hand. Matches IDLE_MS so a note touched during the current idle
 * window is left alone until the next cycle. */
const ORGANIZE_EDIT_COOLDOWN_MS = 60_000
import { processInboxNote } from '@/agent/inbox'

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
  const now = Date.now()
  const activeSlug = getActiveSlugFromHash()
  const fresh = useDocsStore.getState().knownDocs.filter((d) => {
    if (!d.relPath?.startsWith(capturePrefix) || d.archivedAt) return false
    const ingestedAt = ingest.lastIngestedAt[d.slug] ?? 0
    const editedAt = ingest.lastEditedAt[d.slug] ?? 0
    // Has new content to file? (never ingested, or edited since last ingest)
    if (!(ingestedAt === 0 || editedAt > ingestedAt)) return false
    // Leave a note the user is actively working on ALONE — filing it now would
    // move/rewrite it out from under them and swallow their in-flight edit (the
    // race that orphaned a manual edit). Skip the note open in the editor, and
    // any edited within the idle window (they only just paused on it).
    if (d.slug === activeSlug) return false
    if (now - editedAt < ORGANIZE_EDIT_COOLDOWN_MS) return false
    return true
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
