// Mirror a COMMENTED highlight (one the user attached a note to) into
// today's daily note, nested under the article's breadcrumb:
//
//   - [[A Recipe for Training Neural Networks]]
//     - "overfit a single batch" — 단일 배치부터 검증
//     - "always start simple" — 이거 우리 워크플로우에 적용
//
// Only commented highlights land here — a note is the user's own thought,
// journal-worthy; bare highlights stay in the article as the amber mark.
// So the daily is all the user's voice (nothing to visually distinguish),
// and the wiki ingest downstream sees real commentary, not bare quotes.
//
// Saving an article already drops a `- [[Title]]` breadcrumb in the daily
// (saveArticle); a comment nests as a child bullet under it, so the
// article is named once and the notes group beneath it. The existing wiki
// ingest weaves them into wiki entities — no new pipeline.
//
// Append-once: removing a highlight does NOT rewrite the daily (it's an
// append-only journal). Reuses the daily-write engine (applyToWikiPage)
// verbatim — only the insertion point (under the parent) is new.

import { applyToWikiPage } from '@/agent/applyIngest'
import { ensureTodayDailySlug } from '@/lib/saveArticle'

/** Max quote length kept in the daily bullet; the full quote stays in
 * the article's highlight record. Long highlights would bloat the
 * journal line otherwise. */
const DAILY_QUOTE_CAP = 200

function dailyChildLine(quote: string, note?: string): string {
  const oneLine = quote.replace(/\s+/g, ' ').trim()
  const capped =
    oneLine.length > DAILY_QUOTE_CAP ? `${oneLine.slice(0, DAILY_QUOTE_CAP)}…` : oneLine
  const n = note?.trim()
  // Inline-quoted bullet. (A nested blockquote `  > …` was tried but
  // Milkdown renders blockquote-inside-list badly — hoisted above
  // siblings, wrong indent — so the quote stays inline in the bullet.)
  return `  - "${capped}"${n ? ` — ${n}` : ''}`
}

/** A daily breadcrumb line for `title`, tolerant of how Milkdown
 * re-serializes the daily: any bullet marker (`-` `*` `+`) and
 * commonmark-escaped brackets (`\[\[ … \]\]`). Our exact `- [[Title]]`
 * is only the FRESH form; once the editor round-trips the note it
 * becomes `* [[Title]]`, so a strict compare would miss it and we'd
 * append a duplicate breadcrumb. */
function isBreadcrumb(line: string, title: string): boolean {
  const m = line.match(/^[-*+]\s+(.*)$/)
  if (!m) return false
  const body = m[1].trim().replace(/\\([[\]])/g, '$1')
  return body === `[[${title}]]`
}

/** An indented (child) content line. */
function isChildLine(line: string): boolean {
  return /^\s+\S/.test(line)
}

function isBlank(line: string): boolean {
  return line.trim() === ''
}

/** A child bullet's content, marker-agnostic, for dedup (`  - "x"` and
 * `  * "x"` are the same highlight). */
function childBody(line: string): string {
  return line.replace(/^\s*[-*+]\s+/, '').trim()
}

/** Insert the highlight under the article's breadcrumb in today's daily.
 *
 * Robust to Milkdown's re-serialization (marker `-`↔`*`, loose lists with
 * blank lines between items, escaped brackets) — see `isBreadcrumb`. Also
 * SELF-HEALS: if the same article ended up with several breadcrumb blocks
 * (the strict-match bug created duplicates), they're consolidated into one
 * at the first block's position, children in document (chronological)
 * order, newest appended last. Idempotent — an identical child is skipped.
 *
 * When no breadcrumb exists (article saved another day), a fresh
 * `- [[title]]` + child is appended at the end. */
export function insertHighlightUnderSource(
  oldMd: string,
  title: string,
  quote: string,
  note?: string,
): string {
  const child = dailyChildLine(quote, note)
  const lines = oldMd.split('\n')

  // Walk the doc, pulling every breadcrumb block for this title out into
  // `children`, leaving all other lines in `out`. `firstBlockPos` is where
  // the single merged block will be re-inserted.
  const out: string[] = []
  const children: string[] = []
  let firstBlockPos = -1
  let i = 0
  while (i < lines.length) {
    if (!isBreadcrumb(lines[i], title)) {
      out.push(lines[i])
      i++
      continue
    }
    if (firstBlockPos === -1) firstBlockPos = out.length
    i++ // skip the breadcrumb line itself
    // Consume its child block: child lines, plus blank lines that sit
    // BETWEEN children (loose list). Trailing blanks before the next
    // top-level content are left in `out` so following sections keep
    // their spacing.
    while (i < lines.length) {
      if (isChildLine(lines[i])) {
        children.push(lines[i])
        i++
        continue
      }
      if (isBlank(lines[i])) {
        let j = i
        while (j < lines.length && isBlank(lines[j])) j++
        if (j < lines.length && isChildLine(lines[j])) {
          i = j // blank(s) between children → skip, more children follow
          continue
        }
      }
      break // trailing blank or next top-level content → block ends
    }
  }

  if (firstBlockPos === -1) {
    const head = oldMd.replace(/\s+$/, '')
    const sep = head.length > 0 ? '\n\n' : ''
    return `${head}${sep}- [[${title}]]\n${child}`
  }

  if (!children.some((c) => childBody(c) === childBody(child))) {
    children.push(child)
  }
  out.splice(firstBlockPos, 0, `- [[${title}]]`, ...children)
  return out.join('\n')
}

/** Append the highlight to today's daily under the article breadcrumb.
 * Best-effort and fire-and-forget: a failed daily write must never fail
 * the highlight itself (the record + mark are already saved). */
export async function appendHighlightToDaily(
  articleTitle: string,
  quote: string,
  note?: string,
): Promise<void> {
  const title = articleTitle.trim()
  if (!title || !quote.trim()) return
  try {
    const dailySlug = ensureTodayDailySlug()
    await applyToWikiPage(dailySlug, (oldMd) =>
      insertHighlightUnderSource(oldMd, title, quote, note),
    )
  } catch (err) {
    console.warn('[highlight] daily append failed', err)
  }
}
