// Renders the Read Later queue as a markdown list for the chat agent.
//
// On the `/read-later` route there's no editor document, so the chat
// engine has no `view` text to use as the "current page" context. This
// builds a stand-in: the same article list the queue view shows, as a
// markdown block fed to the agent (NOT rendered to the user). With it,
// "summarize my unread articles" answers from the list, and the agent can
// `Glob`/`Read` `articles/*.md` for any single article's full body.

import { useDocsStore } from '@/state/docsStore'

/** One-line-safe cell: strip newlines / collapse whitespace so a title
 * with a stray newline can't break the list row. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function dateLabel(savedAt?: string): string {
  if (!savedAt) return ''
  const d = new Date(savedAt)
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10)
}

/** Build the markdown the chat agent sees as the current page when the
 * user is on the Read Later queue. Newest save first, unread flagged,
 * with the source URL so the agent can identify / open each piece. */
export function buildQueueContextMarkdown(): string {
  const articles = useDocsStore
    .getState()
    .knownDocs.filter((d) => d.type === 'article' && !d.archivedAt)
    .sort((a, b) => (b.savedAt ?? '').localeCompare(a.savedAt ?? ''))

  const unread = articles.filter((d) => !d.readAt).length

  const lines = [
    `# Read Later — saved articles (read-only view)`,
    ``,
    `${articles.length} saved · ${unread} unread. The full body of each`,
    `article lives at \`articles/<title>.md\` — Glob/Read it when the user`,
    `wants detail beyond this list.`,
    ``,
  ]

  if (articles.length === 0) {
    lines.push('_No saved articles yet._')
    return lines.join('\n')
  }

  for (const d of articles) {
    const title = oneLine(d.title ?? 'Untitled')
    const site = d.siteName ? oneLine(d.siteName) : ''
    const date = dateLabel(d.savedAt)
    const status = d.readAt ? 'read' : 'unread'
    const meta = [site, date, status].filter(Boolean).join(' · ')
    const link = d.sourceUrl ? `[${title}](${d.sourceUrl})` : title
    lines.push(`- ${link} — ${meta}`)
  }

  return lines.join('\n')
}
