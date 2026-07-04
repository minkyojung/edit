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
import { loadRoutinePrompt } from '@/lib/routinesLib'

/** Routing brain for inbox captures. Mirrors the wiki/daily/skip
 * taxonomy but points the model at its own edit tools instead of a
 * structured-output contract. Kept local to this module so it doesn't
 * touch the shared chat / CLAUDE.md prompt surfaces. */
export const INBOX_PROMPT = `You are processing ONE note that just landed in the user's inbox — a saved article, a transcript, or a quick capture. Read it, then route its content fact by fact, proposing edits directly with your tools (propose_edit / propose_multi_edit / propose_write). The CLAUDE.md schema above governs vault layout and formatting; this block adds the routing decision.

Three destinations, decided fact by fact:
- **wiki** — durable, reusable knowledge: a concept, framework, method, or a specific non-obvious fact about an entity (a person, book, project, idea) the user will look up later. Find the entity's page first (read \`_system/index.md\`, then Glob/Grep \`wiki/\`); append to it with propose_edit, or propose_write a new \`wiki/<Title>.md\` when none fits. Never invent a page id; never rewrite existing lines (append only). Cross-reference with [[Page Title]] using exact index titles.
- **daily** — what the user DID, an opinion or takeaway they expressed, or a dated event. Add ONE short bullet (the user's voice) to today's daily note by APPENDING with \`propose_edit\` — anchor on the file's last line and put your bullet after it. NEVER use \`propose_write\` on the daily: it replaces the whole journal. The daily is the user's own writing — only ever add lines, never rewrite or remove existing ones.
- **skip** — trivia, well-known labels, promotional / ad content, passing mentions, or behaviour preferences (those belong in CLAUDE.md, which you don't edit here). Propose nothing for these.

A typical capture produces BOTH: a few durable ideas → wiki, plus a couple of "did / concluded" lines → daily. Bias toward keeping over skipping — a slightly redundant note costs little, a lost insight costs a lot — but don't store obvious definitions.

Then FILE the raw note out of the inbox: once its durable content is in the wiki (and any dated lines in the daily), call \`move_note\` with the note's path and the folder that best fits it per the CLAUDE.md schema — this keeps the capture folder a staging area, not a graveyard. The move is applied immediately and is reversible, so don't ask. But only move when you're confident where it belongs; if the note was all skip, or you're unsure of its home, LEAVE it in the inbox — never force a move or route it back into the capture folder.

Work efficiently: keep discovery tight (~5 tool calls), propose rather than ask, and stop once you've routed everything worth keeping.`

/** Process a single inbox note: hand it to the chat agent with the
 * inbox routing instruction and let it propose wiki / daily edits.
 * Returns the run result (proposals land in the pending-changes queue
 * for the user to approve). Throws on an unknown slug. */
export async function processInboxNote(slug: string): Promise<RunChatResult> {
  const known = useDocsStore.getState().knownDocs.find((d) => d.slug === slug)
  if (!known) throw new Error(`unknown inbox doc: ${slug}`)
  const relPath = known.relPath ?? `${slug}.md`

  // Routing brain: the user-editable `.claude/commands/organize.md` if present,
  // else the hardcoded INBOX_PROMPT. Same behavior until the user edits the file.
  const systemPrompt = await loadRoutinePrompt('organize', INBOX_PROMPT)
  return runIntake({
    slug,
    systemPrompt,
    prompt: `A new note just landed in the inbox at \`${relPath}\`. Read it, then route its content to the wiki and today's daily note per your instructions.`,
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
