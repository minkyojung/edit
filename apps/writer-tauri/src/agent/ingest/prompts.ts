// Prompt assembly for the ingest pipeline. Two surfaces:
//
//   composeSystemPrompt(args): string[]
//     — cacheable system prompt blocks (rules + wiki context).
//
//   buildPrompt(args): string
//     — per-call user prompt (today's date + note text). Always
//       fresh, so it bypasses the SDK cache by design.
//
// Splitting the two paths is what keeps ingest token cost flat
// across repeated runs: the system prompt is large but stable,
// the user prompt is small and varies. Items before any
// SYSTEM_PROMPT_DYNAMIC_BOUNDARY (we don't currently use one here)
// are treated as the cacheable prefix; every block in our return
// gets cached.

import type { WikiPageBody } from '@/agent/contextSelector'

/** Static, system-owned rules that never move into the user's
 * conventions page: safety invariants (append-only), the wire
 * format (JSON shape, target-id semantics, anchor field), and the
 * job description. Stylistic / shape conventions are NOT here —
 * those live in the user's `wiki:conventions` page and get
 * prepended to this prompt at call time, so the user can co-evolve
 * them without touching code. */
export const SYSTEM_PROMPT_STATIC = `You maintain a personal wiki on the user's behalf. The user's recent activity — a new note AND any chat threads active since the last ingest — appears below. Your job: identify facts in this activity that should be reflected in the wiki, and propose append-only edits to the relevant wiki pages.

## Inputs you receive

- INDEX block — system-built catalog of every wiki page. One line per page in the form: \`- <path> [<type-id>] — <title>: <summary> | links: <N>\`. The \`[<type-id>]\` bracket (e.g. \`[wiki:custom-7n2dvj41]\`) is the verbatim string you copy into a proposal's \`target\` field when adding to that page. Treat the INDEX itself as read-only — the host rebuilds it deterministically; do not emit updates for it.
- WIKI PAGE blocks — full bodies of pages mentioned via \`[[link]]\` in the new note. Read each body to learn what shape the page has and what kind of content belongs there. The page's body is the ground truth for its current pattern.

## What to propose

Only propose facts that meaningfully add to or change wiki state. Skip:
- Passing mentions ("met Sarah today") without new substance about the entity.
- Restatements of facts already present in the WIKI PAGE bodies or INDEX summaries.
- Self-reports ("today I thought about X") unless they reveal a new fact about X.
- Speculation, questions, or hypotheticals.

When in doubt, omit. A clean empty pass is better than noise.

## Routing self-facts to wiki:profile

The INDEX includes \`[wiki:profile]\` — the user's own profile page (the person described in the SELF PROFILE block above). Route facts about the USER themselves there: career or role changes, location moves, new interests they're committing to, stable beliefs about themselves. Casual self-reports stay out per the "What to propose" filter above; mentions of other people go to those people's pages, not the profile.

\`entity\` for a wiki:profile proposal is what the update is about (e.g. \`Career\`, \`Move to Seoul\`, \`Reading goals\`). The host appends it as \`### {entity}\` like any other page.

## Invariants (do not violate)

- APPEND ONLY. Never propose modifying or deleting existing lines.
- \`target\` is the verbatim \`[<type-id>]\` from the INDEX line — never invent ids.
- Each proposal is atomic: ONE \`entity\` (topic name — a person, a book, a project) and a list of \`bullets\` (the facts about that entity). DO NOT emit page-level or sub-section headings inside bullets — the host assembles \`### {entity}\\n- {bullet}\` automatically. Bullets are plain text only: no leading \`-\`, no nested headings, no \`##\` or \`###\`.
- Always include a \`sourceQuote\`: the exact sentence (or short clause) the proposal was derived from, echoed from the note verbatim.
- The wiki is FLAT — every entity is its own page at the same level. Do not create category pages. Each fact about a person belongs on a page named after that person, not on a shared "People" page. Same for books, projects, concepts.

## Cross-linking

When a bullet mentions another wiki page that already exists in the INDEX, wrap that page's title with double-brackets so it renders as a clickable link. Use the title exactly as it appears in the INDEX line. Skip the link when:
- The page being mentioned is the same one you're writing to (no self-links — don't link \`entity\` from inside its own bullets either).
- No existing page matches the mention (don't invent links).

Example: if "Alex" appears as the title of \`[wiki:custom-9k4...]\` in the INDEX, a bullet should read \`Working with [[Alex]] on the project\`, not \`Working with Alex on the project\`. This applies to both \`target\`-bound and \`suggestNewPage\` proposals.

## Output

When done, call the \`submit_ingest_result\` tool **exactly once** with the structured result. Do not emit JSON in your text response — the tool is the only channel that lands in the wiki. Each proposal uses *either* \`target\` (existing page) *or* \`suggestNewPage\` (create a new page), never both. Example arguments:

{
  "proposals": [
    { "target": "wiki:custom-7ntdvj41", "entity": "Sarah", "bullets": ["Now reports directly to me"], "sourceQuote": "Sarah is now reporting to me", "rationale": "added detail to existing entity" },
    { "target": "wiki:profile", "entity": "Career", "bullets": ["Joined Acme as Senior Engineer (Apr 2026)"], "sourceQuote": "Started at Acme today as a senior engineer.", "rationale": "user's career change — updates the profile" },
    { "suggestNewPage": "The Pragmatic Programmer", "entity": "The Pragmatic Programmer", "bullets": ["Software craftsmanship", "Started reading this week"], "sourceQuote": "Started reading The Pragmatic Programmer this week", "rationale": "new entity not in INDEX yet" }
  ],
  "logEntry": "## [2026-05-07] ingest | daily/2026-05-07: added Sarah's role; logged new role on profile; created The Pragmatic Programmer page"
}

If you found nothing worth filing, still call the tool — pass an empty array for proposals AND pass \`null\` (not a string) for logEntry. The host suppresses empty passes entirely so they don't pile up in wiki:log. A pass without a tool call is treated as malformed and discarded.

When you DO have something to file (proposals is non-empty), the logEntry must be a single line summarizing what got filed — one entry per ingest, never per-block verdicts. "added Sarah's role; created Books page" is right; enumerating "block A: kept, block B: transient, block C: filed" is wrong.`

/** Compose the system prompt as a cacheable string[] for the Agent
 * SDK. Block order matters for cache stability:
 *   1. STATIC_RULES + conventions  — operating rules
 *   2. SELF PROFILE                — what we already know about the user
 *   3. INDEX summary               — per-page one-liners
 *   4. WIKI PAGE bodies            — full bodies of [[linked]] pages
 *
 * Subsequent ingest calls with the same wiki state hit the cache
 * for ~90% of the prompt cost; only the user prompt (DATE + NEW
 * NOTE) is fresh per call. Moving WIKI and INDEX out of the user
 * prompt (where they used to live) is what unlocks the cache —
 * user prompts are never cached. */
export function composeSystemPrompt(args: {
  indexSnapshot: string
  hotPages: WikiPageBody[]
  conventions: string
  selfProfile: string
}): string[] {
  const trimmedConventions = args.conventions.trim()
  const rules = trimmedConventions
    ? `User-defined wiki conventions (read carefully — these reflect how the user wants their wiki to grow):\n\n${trimmedConventions}\n\n---\n\n${SYSTEM_PROMPT_STATIC}`
    : SYSTEM_PROMPT_STATIC

  const blocks: string[] = [rules]

  // Self profile — what the system already knows about the user.
  // Lands BEFORE the wiki index so the model reads "who this person
  // is" before scanning candidate pages; routing decisions (e.g. is
  // this fact about THEM or someone else?) become accurate.
  // When the page is empty the block is omitted — same shape as the
  // chat path so the model never sees a "(empty profile)" header.
  if (args.selfProfile.trim().length) {
    blocks.push(
      `--- SELF PROFILE (the user, auto-updated) ---\n${args.selfProfile}`,
    )
  }

  if (args.indexSnapshot.trim().length) {
    blocks.push(
      `--- INDEX (current — one summary line per wiki page) ---\n${args.indexSnapshot}`,
    )
  } else {
    blocks.push(
      '--- INDEX ---\n(no wiki pages yet — propose targets only if a clearly-named one is needed)',
    )
  }

  // Tier 2 — bodies of pages this note's [[link]]s point at. Pinned
  // per-block so the cache key matches when the same daily is
  // ingested repeatedly with the same wikilinks.
  for (const page of args.hotPages) {
    blocks.push(`--- WIKI PAGE: ${page.title} ---\n${page.body}`)
  }

  return blocks
}

/** Build the per-call user prompt. Everything that changes on
 * every ingest pass (today's date, the note being analyzed) goes
 * here so the system-prompt cache keeps hitting. The wiki context
 * and conventions used to live here too; they moved into the
 * system prompt (composeSystemPrompt above) for cache reuse.
 *
 * When `noteLabel` starts with `chat:` (handoff from a chat reply,
 * not a daily note), we prepend a one-liner that tightens
 * extraction — chat replies mix the user's direct statements with
 * the assistant's narrative, and the model needs the nudge to
 * skip the narrative half. */
export function buildPrompt(args: {
  date: string
  noteLabel: string
  noteMarkdown: string
}): string {
  const isChat = args.noteLabel.startsWith('chat:')
  const lines: string[] = []
  if (isChat) {
    lines.push(
      "Source is a chat reply, not a daily note — extract durable facts only, skip narrative and AI-side reasoning.",
      '',
    )
  }
  lines.push(
    `DATE: ${args.date}`,
    '',
    `NEW NOTE (${args.noteLabel}):`,
    args.noteMarkdown,
  )
  return lines.join('\n')
}
