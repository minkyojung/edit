// Daily ingest — file durable facts from the user's daily journal into the
// wiki, via the same general intake agent the inbox uses. Replaces the
// structured ingest engine (runIngest + submit_ingest_result + parse) with a
// runIntake pass: the agent reads the daily note and proposes wiki edits
// directly through the approval queue. No JSON contract, no per-block hashing
// — duplicate-skipping is the agent's job (read the target page first).

import { runIntake } from '@/agent/intake'
import type { RunChatResult } from '@/agent/chat/types'
import { useDocsStore } from '@/state/docsStore'

// Role-framed routing brain (was the `/daily-ingest` command body). Leans on the
// vault's CLAUDE.md — injected alongside — for the mechanics (how to navigate the
// index, append via propose_*, link with [[...]]); this states WHO the agent is
// and WHAT belongs in the wiki, not step-by-step procedure.
const DAILY_INGEST_BRAIN = `You are the wiki maintainer, tending the user's second brain. Your job right now: read the user's daily journal note and file its durable knowledge into the wiki, per the vault's CLAUDE.md schema and editing rules.

Keep only what's worth re-finding later — a specific, non-obvious fact about an entity (a person, book, project, idea), or a concept, framework, or method. Skip transient signals: moods, weather, routine logistics, small talk. Skip anything the wiki already holds in any form.

The daily note is the user's own raw writing — never edit it. Propose your wiki additions through the approval queue; if nothing durable is new, propose nothing.`

/** Run a daily-journal ingest pass against one daily note slug. The agent
 * reads it and proposes wiki edits into the pending-changes queue. Returns the
 * run result. Throws on an unknown slug. */
export async function processDailyNote(slug: string): Promise<RunChatResult> {
  const known = useDocsStore.getState().knownDocs.find((d) => d.slug === slug)
  if (!known) throw new Error(`unknown daily doc: ${slug}`)
  const relPath =
    known.relPath ??
    (known.type === 'daily' && known.date ? `daily/${known.date}.md` : `${slug}.md`)

  // The routing brain rides as the system prompt; the kickoff just points the
  // agent at the note (it Reads the file itself — no content injected here).
  return runIntake({
    slug,
    systemPrompt: DAILY_INGEST_BRAIN,
    prompt: `Read the daily note at \`${relPath}\` and file its durable facts into the wiki.`,
  })
}
