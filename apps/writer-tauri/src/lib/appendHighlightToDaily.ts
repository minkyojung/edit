// Mirror a saved-article highlight into today's daily note, nested under
// the article's breadcrumb:
//
//   - [[A Recipe for Training Neural Networks]]
//     - "overfit a single batch"
//     - "always start simple" — 이거 우리 워크플로우에 적용
//
// Saving an article already drops a `- [[Title]]` breadcrumb in the
// daily (saveArticle); a highlight nests as a child bullet under it, so
// the article is named once and the takeaways group beneath it. From the
// daily, the existing wiki ingest weaves the quotes into wiki entities —
// no new pipeline.
//
// Append-once: this runs at highlight-create time. Removing a highlight
// does NOT rewrite the daily (it's an append-only journal). Reuses the
// daily-write engine (applyToWikiPage) verbatim — only the insertion
// point (under the parent, not at the end) is new.

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
  return `  - "${capped}"${n ? ` — ${n}` : ''}`
}

/** Insert `child` under the `- [[title]]` breadcrumb: after that
 * article's existing child bullets (preserving reading order), or as a
 * fresh `- [[title]]` + child appended at the end when no breadcrumb
 * exists (e.g. the article was saved on a different day). Idempotent —
 * an identical child line already present is left untouched. Pure
 * line-based logic over our own controlled format. */
export function insertHighlightUnderSource(
  oldMd: string,
  title: string,
  quote: string,
  note?: string,
): string {
  const parent = `- [[${title}]]`
  const child = dailyChildLine(quote, note)

  const lines = oldMd.split('\n')
  const pIdx = lines.findIndex((l) => l.trimEnd() === parent)

  if (pIdx === -1) {
    const head = oldMd.replace(/\s+$/, '')
    const sep = head.length > 0 ? '\n\n' : ''
    return `${head}${sep}${parent}\n${child}`
  }

  // Walk past this article's child block (consecutive indented lines).
  let insertAt = pIdx + 1
  while (insertAt < lines.length && lines[insertAt].startsWith('  ')) {
    if (lines[insertAt].trimEnd() === child) return oldMd // dedup
    insertAt++
  }
  lines.splice(insertAt, 0, child)
  return lines.join('\n')
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
