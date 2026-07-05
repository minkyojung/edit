// Daily ingest — file durable facts from the user's daily journal into the
// wiki, via the same general intake agent the inbox uses. Replaces the
// structured ingest engine (runIngest + submit_ingest_result + parse) with a
// runIntake pass: the agent reads the daily note and proposes wiki edits
// directly through the approval queue. No JSON contract, no per-block hashing
// — duplicate-skipping is the agent's job (read the target page first).

import { runIntake } from '@/agent/intake'
import type { RunChatResult } from '@/agent/chat/types'
import { useDocsStore } from '@/state/docsStore'

/** Run a daily-journal ingest pass against one daily note slug. The agent
 * reads it and proposes wiki edits into the pending-changes queue. Returns the
 * run result. Throws on an unknown slug. */
export async function processDailyNote(slug: string): Promise<RunChatResult> {
  const known = useDocsStore.getState().knownDocs.find((d) => d.slug === slug)
  if (!known) throw new Error(`unknown daily doc: ${slug}`)
  const relPath =
    known.relPath ??
    (known.type === 'daily' && known.date ? `daily/${known.date}.md` : `${slug}.md`)

  // Native: send the `/daily-ingest` plugin command with the note path as its
  // argument; the SDK expands the command body (routing brain) into the user
  // turn, substituting `$ARGUMENTS` = the path.
  return runIntake({
    slug,
    prompt: `/daily-ingest ${relPath}`,
  })
}
