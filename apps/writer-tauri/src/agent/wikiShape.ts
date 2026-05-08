// Wiki page shape detection — Karpathy "schema lives in the wiki
// itself" pattern. Each wiki:* page settles into one of a few
// natural shapes based on what's already in it; we read the shape
// off the live markdown rather than tracking it in metadata, so
// the page can drift and the next ingest pass adapts automatically.
//
// Shapes:
//   empty    — body is blank or zero-width-only. Next ingest picks
//              the most natural shape for the content type.
//   timeline — body has at least one `## [YYYY-MM-DD] ...` line.
//              Used by wiki:log; new entries follow the same prefix.
//   entity   — body has at least one `### Name` heading. Each entity
//              gets its own H3 section; facts about it become bullets
//              under that section. Used by entity-style pages
//              (wiki:entity, wiki:custom-people, etc.).
//   list     — body is flat bullets, no H3 sections. Each fact is
//              one atomic bullet. Used by wiki:belief and similar
//              "list of preferences" pages.
//   prose    — anything else (free-form paragraphs). Falls through.
//
// Priority on detection: timeline > entity > list > prose. The
// strongest structural signal wins, so a page that has both a date
// log line and an H3 heading reads as timeline (the log is the
// stronger commitment).

export type WikiShape =
  | 'empty'
  | 'timeline'
  | 'entity'
  | 'list'
  | 'prose'

/** Detect the shape of a wiki page's markdown body. Pure — input is
 * the raw markdown, output is one of the shape labels. Used both at
 * read time (when assembling the chat prompt) and at write time
 * (when ingest decides how to format new content). */
export function detectShape(markdown: string): WikiShape {
  // Strip ZWS placeholders and surrounding whitespace before checking
  // emptiness; an empty body with just a ZWS reads as 'empty', not
  // 'prose', so the first ingest can pick the natural shape freely.
  const stripped = markdown.replace(/[​]/g, '').trim()
  if (stripped.length === 0) return 'empty'

  // Timeline beats everything else: a `## [YYYY-MM-DD]` prefix is the
  // strongest, most committal pattern (an append-only log).
  if (/^##\s+\\?\[\d{4}-\d{2}-\d{2}\]/m.test(markdown)) return 'timeline'

  // Entity is the next strongest: any H3 heading means the page is
  // organized around named items.
  if (/^###\s+\S/m.test(markdown)) return 'entity'

  // List: every non-blank, non-heading line is a bullet. We allow
  // H1/H2 headings (page title, section dividers) but the actual
  // content has to be 100% bullets to register as a list — a
  // single prose paragraph kicks it into prose territory.
  const contentLines = markdown
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^#{1,2}\s/.test(l))
  if (
    contentLines.length > 0 &&
    contentLines.every((l) => /^[-*•]\s/.test(l))
  ) {
    return 'list'
  }

  return 'prose'
}

// Dev-only console hook for prompt-iteration. Call from devtools:
//   __detectShape('### Sarah\n- foo')   → 'entity'
//   __detectShape('## [2026-05-07] x')  → 'timeline'
//   __detectShape('- a\n- b')           → 'list'
//   __detectShape('Hello world.')       → 'prose'
//   __detectShape('')                   → 'empty'
if (import.meta.env.DEV) {
  ;(window as unknown as { __detectShape: typeof detectShape }).__detectShape =
    detectShape
}
