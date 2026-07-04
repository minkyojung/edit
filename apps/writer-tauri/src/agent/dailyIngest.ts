// Daily ingest — file durable facts from the user's daily journal into the
// wiki, via the same general intake agent the inbox uses. Replaces the
// structured ingest engine (runIngest + submit_ingest_result + parse) with a
// runIntake pass: the agent reads the daily note and proposes wiki edits
// directly through the approval queue. No JSON contract, no per-block hashing
// — duplicate-skipping is the agent's job (read the target page first).

import { runIntake } from '@/agent/intake'
import type { RunChatResult } from '@/agent/chat/types'
import { useDocsStore } from '@/state/docsStore'

/** Routing brain for a daily-journal ingest pass. Source = the user's own
 * daily note (raw, never edited); target = wiki only. */
export const DAILY_INGEST_PROMPT = `You are filing durable facts from the user's daily journal note into their wiki. Read the note at \`$ARGUMENTS\`. Extract only durable, consequential knowledge — a specific non-obvious fact about an entity (a person, book, project, idea), or a concept / framework / method worth re-finding later. Skip transient signals: today's lunch, fleeting moods, weather, routine logistics.

For each durable fact: find the entity's wiki page via \`_system/index.md\` + \`Glob\` / \`Grep\` on \`wiki/\`, then READ that page and SKIP the fact if it already lives there in any form (duplication degrades the wiki faster than a missed update). Otherwise \`propose_edit\` to append a bullet (anchor on a line that exists), or \`propose_write\` a new \`wiki/<Title>.md\` when no page fits. Append only — never rewrite existing lines. Cross-reference related pages with [[Page Title]] using exact index titles.

The daily note is the user's raw source — NEVER edit the daily itself. If nothing durable is new, propose nothing.`

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
