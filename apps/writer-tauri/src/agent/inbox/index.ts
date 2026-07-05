// Inbox intake — process ONE note that landed in the inbox by handing
// it to the ordinary chat agent (the Claude Code-native path), NOT a
// separate structured-output engine.
//
// The agent already knows how to navigate the vault (built-in
// Read/Glob/Grep + `_system/index.md`) and how to propose edits
// (propose_edit / propose_multi_edit / propose_write, gated through the
// pending-changes approval flow). So routing is just an instruction:
// "read this inbox note, send durable facts to the wiki and dated
// actions to today's daily, using your edit tools." No
// `submit_ingest_result`, no parse step, no separate apply layer — the
// agent does the work and the existing approval flow stages it.
//
// Trigger (an inbox folder watcher) and dedup are layered on top in a
// later step; this module is the headless run itself.

import { runIntake } from '@/agent/intake'
import type { RunChatResult } from '@/agent/chat/types'
import { useDocsStore } from '@/state/docsStore'
import { getDefaultNoteFolder } from '@/state/settingsStore'

/** Process a single inbox note: hand it to the chat agent with the
 * inbox routing instruction and let it propose wiki / daily edits.
 * Returns the run result (proposals land in the pending-changes queue
 * for the user to approve). Throws on an unknown slug. */
export async function processInboxNote(slug: string): Promise<RunChatResult> {
  const known = useDocsStore.getState().knownDocs.find((d) => d.slug === slug)
  if (!known) throw new Error(`unknown inbox doc: ${slug}`)
  const relPath = known.relPath ?? `${slug}.md`

  // Native: send the `/organize` plugin command with the note path as its
  // argument. The SDK loads the command body (the routing brain) from the
  // vault's agent plugin and expands it into the user turn, substituting
  // `$ARGUMENTS` = the path — no hand-rolled prompt loading.
  return runIntake({
    slug,
    prompt: `/organize ${relPath}`,
  })
}

/** List inbox captures (slug + title + relPath) — `useDocsStore` isn't a
 * console global, so this is the easy way to grab a slug for __processInbox. */
function listInboxNotes(): Array<{ slug: string; title?: string; relPath?: string }> {
  const capturePrefix = getDefaultNoteFolder() + '/'
  return useDocsStore
    .getState()
    .knownDocs.filter((d) => d.relPath?.startsWith(capturePrefix))
    .map((d) => ({ slug: d.slug, title: d.title, relPath: d.relPath }))
}

/** Dev-only console handles for tuning the inbox intake runner:
 *
 *   __inbox()                       // list inbox notes → pick a slug
 *   await __processInbox('<slug>')  // route that note (stages proposals)
 */
if (import.meta.env.DEV) {
  const w = window as unknown as {
    __processInbox: typeof processInboxNote
    __inbox: typeof listInboxNotes
  }
  w.__processInbox = processInboxNote
  w.__inbox = listInboxNotes
}
