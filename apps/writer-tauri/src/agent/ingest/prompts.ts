// Prompt assembly for the ingest pipeline.
//
//   composeSystemPrompt(args): string[]
//     — cacheable system prompt blocks. Vault schema lives in
//       CLAUDE.md (vault root); profile + conventions ride along
//       as in chat. The ingest-specific block teaches the model
//       how to navigate the vault with built-in tools and what
//       structured output to emit at the end.
//
//   buildPrompt(args): string
//     — per-call user prompt (today's date + note text). Always
//       fresh, so it bypasses the SDK cache by design.
//
// As of the Claude Code alignment, ingest is an **agent loop**:
// the model reads `_system/index.md`, navigates with Glob / Grep /
// Read, then emits a single `submit_ingest_result` tool call. The
// previous always-on dump of WIKI INDEX + WIKI PAGE bodies is gone
// — Anthropic's published Claude Code design says agentic search
// beats index dumps once the model is strong enough at tool use
// (Sonnet 4.5+), and our chat flow already runs on that pattern.

/** Ingest-specific system prompt. Anchors the agent loop on top
 * of the shared CLAUDE.md + profile + conventions prefix that
 * `assembleContext` produces.
 *
 * Section ordering inside this block:
 *   1. Role           — what the model is doing on this turn.
 *   2. Inputs         — what it will receive next (the daily blob).
 *   3. Tools          — how to use Read / Glob / Grep, and the
 *                       single output channel `submit_ingest_result`.
 *   4. Selection      — what to file vs skip.
 *   5. Routing        — wiki:profile vs other pages, new pages.
 *   6. Invariants     — append-only, target verbatim, sourceQuote, flat layout.
 *   7. Cross-linking  — `[[Title]]` rules.
 *   8. Output schema  — JSON shape, examples, empty-pass behaviour.
 *
 * Stylistic / shape conventions remain in the user's
 * `wiki:conventions` page (loaded by assembleContext); the prefix
 * concatenates them before this block so the user can co-evolve
 * those rules without touching code. */
const INGEST_SYSTEM = `You are the ingest agent for the user's personal wiki. You receive recent daily-note activity below and propose append-only edits to the wiki pages that should reflect it. The CLAUDE.md schema above already describes the vault layout, the three-tier discipline, and the ingest operation in general; this block adds the ingest-specific tool usage and wire format you must follow.

## How to work (agent loop)

You have the built-in Read, Glob, and Grep tools, rooted at the vault root. Use them to find what already exists before proposing edits.

1. Start by Reading \`_system/index.md\` once — it lists every wiki page with its \`[type-id]\` (the verbatim string you copy into the \`target\` field) and a one-line summary.
2. For each candidate entity (a person, book, project, concept) you spotted in the note, decide if it already has a page. Use Glob (\`wiki/*.md\`) and Grep on names / aliases to disambiguate. Read a specific page's body only when you actually need its current shape to write a well-formed bullet for it.
3. Keep the search tight. Aim for at most ~5 tool calls. The goal is good routing, not a complete vault audit. If you cannot place an entity confidently after a couple of checks, propose a new page (\`suggestNewPage\`) rather than guessing an existing target.
4. When you have enough information, call \`submit_ingest_result\` **exactly once** with the structured payload below, then stop. Do not emit JSON in free text — the tool is the only channel that lands in the wiki.

## What to propose

Only propose facts that meaningfully add to or change wiki state. Skip:
- Passing mentions ("met Sarah today") without new substance about the entity.
- Restatements of facts already present in the pages you Read.
- Self-reports ("today I thought about X") unless they reveal a new fact about X.
- Speculation, questions, or hypotheticals.

When in doubt, omit. A clean empty pass is better than noise.

## Routing self-facts to wiki:profile

The INDEX includes \`[wiki:profile]\` — the user's own profile page (the person described in the SELF PROFILE block above). Route facts about the USER themselves there: career or role changes, location moves, new interests they're committing to, stable beliefs about themselves. Casual self-reports stay out per the filter above; mentions of other people go to those people's pages, not the profile.

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

Call \`submit_ingest_result\` exactly once with arguments shaped like:

{
  "proposals": [
    { "target": "wiki:custom-7ntdvj41", "entity": "Sarah", "bullets": ["Now reports directly to me"], "sourceQuote": "Sarah is now reporting to me", "rationale": "added detail to existing entity" },
    { "target": "wiki:profile", "entity": "Career", "bullets": ["Joined Acme as Senior Engineer (Apr 2026)"], "sourceQuote": "Started at Acme today as a senior engineer.", "rationale": "user's career change — updates the profile" },
    { "suggestNewPage": "The Pragmatic Programmer", "entity": "The Pragmatic Programmer", "bullets": ["Software craftsmanship", "Started reading this week"], "sourceQuote": "Started reading The Pragmatic Programmer this week", "rationale": "new entity not in INDEX yet" }
  ],
  "logEntry": "## [2026-05-07] ingest | daily/2026-05-07: added Sarah's role; logged new role on profile; created The Pragmatic Programmer page"
}

If you found nothing worth filing, still call the tool — pass an empty array for proposals AND pass \`null\` (not a string) for logEntry. The host suppresses empty passes entirely so they don't pile up in wiki:log. A pass without a tool call is treated as malformed and discarded.

When you DO have something to file (proposals is non-empty), the logEntry must be a single line summarizing what got filed — one entry per ingest, never per-block verdicts.`

/** Compose the system prompt as a cacheable string[] for the Agent
 * SDK. Block order matters for cache stability:
 *   1. CLAUDE.md       — vault schema (rarely changes, user-owned)
 *   2. SELF PROFILE    — what we already know about the user
 *   3. CONVENTIONS     — user-defined wiki rules
 *   4. INGEST_SYSTEM   — agent loop + wire format (this file)
 *
 * Subsequent ingest calls hit the cache for the entire prefix as
 * long as the four blocks above don't change between calls. Only
 * the user prompt (DATE + NEW NOTE, built by `buildPrompt`) is
 * fresh per call. */
export function composeSystemPrompt(args: {
  claudeMd: string
  conventions: string
  selfProfile: string
}): string[] {
  const blocks: string[] = []

  if (args.claudeMd.trim().length) {
    blocks.push(args.claudeMd)
  }

  if (args.selfProfile.trim().length) {
    blocks.push(
      `--- SELF PROFILE (the user, auto-updated) ---\n${args.selfProfile}`,
    )
  }

  if (args.conventions.trim().length) {
    blocks.push(
      `--- USER WIKI CONVENTIONS ---\n${args.conventions}`,
    )
  }

  blocks.push(INGEST_SYSTEM)

  return blocks
}

/** Build the per-call user prompt. Everything that changes on
 * every ingest pass (today's date, the note being analyzed) goes
 * here so the system-prompt cache keeps hitting.
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
