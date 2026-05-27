// Right-side panel surface for reviewing AI changes.
//
// Two sections, top to bottom:
//
//   1. **Pending review** — entries from `pendingChangesStore`:
//      pending plus recently-decided (10 min retention). One row per
//      change. M2 ships the list view; M3 will make rows expand to
//      a side-by-side diff with Apply / Reject actions.
//
//   2. **Recent changes** — git activity from `gitStore`. Same
//      expandable card pattern this panel always used. Commits land
//      here AFTER the user accepts a pending change (the applier
//      writes disk → group-commit → gitStore.activity).
//
// The split reflects the natural lifecycle: a change is "proposed"
// (pending), then "decided" (briefly visible in both sections), then
// "committed" (only in section 2 after the decided retention
// window expires).
//
// File-selection rule for git cards: wiki/ → writing/ → daily/.
// An LLM ingest commit usually touches both the daily (where the
// user wrote) and the wiki page (where the LLM filed). The card is
// "about" the destination — the wiki page — so we prefer that for
// the title and the "Added" diff.

import { useEffect, useMemo } from 'react'
import {
  IconArrowBackUp,
  IconChevronDown,
  IconChevronRight,
  IconHistory,
} from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useGitStore } from '@/state/gitStore'
import {
  usePendingChangesStore,
  type PendingChange,
} from '@/state/pendingChangesStore'
import { useDocsStore } from '@/state/docsStore'
import { renderMarkdownToFragment } from '@/lib/renderMarkdownInline'
import type { CommitInfo, FileDiff } from '@/lib/git'
import { cn } from '@/lib/utils'

export function ReviewPanel() {
  const activity = useGitStore((s) => s.activity)
  const markAllReviewed = useGitStore((s) => s.markAllReviewed)
  const pendingEntries = usePendingReviewEntries()

  // Refresh on mount so the panel reflects the latest state even if
  // the user opened it after a long gap.
  useEffect(() => {
    void useGitStore.getState().refreshActivity()
  }, [])

  const hasActivity = activity.length > 0
  const hasPending = pendingEntries.length > 0
  const isEmpty = !hasActivity && !hasPending

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-col gap-0.5 bg-transparent px-4 py-3 shadow-[inset_0_-1px_0_var(--border)]">
        <h2 className="text-[15px] font-semibold text-foreground">Review</h2>
        {hasPending && (
          <p className="text-[13px] text-muted-foreground">
            {`${pendingEntries.length} change${pendingEntries.length === 1 ? '' : 's'} awaiting your decision`}
          </p>
        )}
        {!hasPending && hasActivity && (
          <p className="text-[13px] text-muted-foreground">
            {`${activity.length} recent change${activity.length === 1 ? '' : 's'}`}
          </p>
        )}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {isEmpty ? (
          // ContentUnavailableView pattern (macOS 14+/iOS 17+):
          // tertiary icon + Title 3 headline + body description. Matches
          // the ChatPanel empty state so the right column reads as one
          // design language regardless of which mode is showing.
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-12">
            <IconHistory
              size={48}
              stroke={1.5}
              className="text-muted-foreground/40"
            />
            <p className="text-[16px] font-semibold text-foreground">
              You&apos;re caught up
            </p>
            <p className="max-w-xs text-center text-[14px] text-muted-foreground">
              Nothing new since your last review.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-4 p-2">
            {hasPending && (
              <PendingSection entries={pendingEntries} />
            )}
            {hasActivity && (
              <HistorySection commits={activity} />
            )}
          </div>
        )}
      </ScrollArea>

      <div className="shrink-0 bg-transparent px-4 py-3 shadow-[inset_0_1px_0_var(--border)]">
        <Button
          variant="default"
          size="sm"
          className="w-full"
          disabled={!hasActivity}
          onClick={() => {
            void markAllReviewed()
          }}
        >
          Mark all reviewed
        </Button>
      </div>
    </div>
  )
}

// ── Pending review section ──────────────────────────────────────

/** Subscribe to `pendingChangesStore` and return the entries the
 * panel should render. Sort order: pending first (newest first),
 * then recently-decided (also newest first). The decided window is
 * already capped by `pruneDecided` (10 min retention) — anything
 * older has been swept by the time we read.
 *
 * Returns a stable identity per render only when the underlying
 * byId / decided window hasn't shifted, so React's diff keeps the
 * row DOM if the user is in the middle of interacting. */
function usePendingReviewEntries(): PendingChange[] {
  const byId = usePendingChangesStore((s) => s.byId)
  return useMemo(() => {
    const all = Object.values(byId)
    const pending = all
      .filter((c) => c.status === 'pending')
      .sort((a, b) => b.createdAt - a.createdAt)
    const decided = all
      .filter((c) => c.status !== 'pending')
      .sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0))
    return [...pending, ...decided]
  }, [byId])
}

function PendingSection({ entries }: { entries: PendingChange[] }) {
  return (
    <section className="flex flex-col">
      <h3 className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Pending review
      </h3>
      <div className="flex flex-col gap-1">
        {entries.map((entry) => (
          <PendingRow key={entry.id} entry={entry} />
        ))}
      </div>
    </section>
  )
}

function HistorySection({ commits }: { commits: CommitInfo[] }) {
  return (
    <section className="flex flex-col">
      <h3 className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Recent changes
      </h3>
      <div className="flex flex-col">
        {commits.map((commit) => (
          <CommitCard key={commit.sha} commit={commit} />
        ))}
      </div>
    </section>
  )
}

/** One pending-change row. M2 = read-only display. M3 will wire the
 * click into an expanded diff with Apply / Reject actions. */
function PendingRow({ entry }: { entry: PendingChange }) {
  const title = usePageTitle(entry.pageSlug)
  const preview = previewLine(entry)
  const time = relativeTime(Math.floor(entry.createdAt / 1000))
  const stat = useMemo(() => diffStat(entry), [entry])

  return (
    <div
      className={cn(
        'flex flex-col gap-0.5 rounded-md px-3 py-2 text-left',
        'hover:bg-muted/60 transition-colors',
      )}
    >
      <div className="flex items-center gap-2 text-sm">
        <StatusDot status={entry.status} />
        <span className="truncate font-medium">{title}</span>
        <DiffStatChars added={stat.added} removed={stat.removed} />
        <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
          {time}
        </span>
      </div>
      {preview && (
        <PreviewLine markdown={preview} />
      )}
    </div>
  )
}

/** Character-count diff stat for a pending row. Replaces the
 * source-type chip — same idea as the github-style `+N -M` summary,
 * just measured in characters so it scales sensibly for prose. We
 * skip the zero side so a pure-add change reads as a clean `+33`
 * without a `-0` companion. */
function DiffStatChars({
  added,
  removed,
}: {
  added: number
  removed: number
}) {
  if (added === 0 && removed === 0) return null
  return (
    <span className="shrink-0 font-mono text-[11px]">
      {added > 0 && (
        <span className="text-green-600 dark:text-green-400">+{added}</span>
      )}
      {removed > 0 && (
        <span className={cn('text-destructive', added > 0 && 'ml-1')}>
          -{removed}
        </span>
      )}
    </span>
  )
}

/** Sum the `before` / `after` character counts across every edit in
 * the change. `add` only contributes to `added`; `delete` only to
 * `removed`; `replace` contributes to both (counted against the full
 * before / after strings, including any surrounding context the LLM
 * cited — the goal is "how much of the page is shifting" rather
 * than a strict net-line count). `write` (whole-doc replace, no
 * before) shows as additions only because we don't have the prior
 * content available in the edit payload. */
function diffStat(entry: PendingChange): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const edit of entry.edits) {
    added += edit.after?.length ?? 0
    removed += edit.before?.length ?? 0
  }
  return { added, removed }
}

/** Status indicator dot — three states, three colours. Compact 6px
 * dot to match Linear-style row density.
 *
 * The dot is centred inside a `h-5` wrapper that matches `text-sm`
 * line-height (20px). Without the wrapper, the parent flex row
 * centres the dot against the line-box middle, but optical-centre
 * of the text glyph sits ~1 px lower; that mismatch read as
 * "dot is too high" against the row's title. Forcing the dot's
 * surrounding container to the text's line height lets it land on
 * the glyph's visual centre. */
function StatusDot({ status }: { status: PendingChange['status'] }) {
  const cls =
    status === 'pending'
      ? 'bg-info'
      : status === 'accepted'
        ? 'bg-green-500'
        : 'bg-muted-foreground/40'
  return (
    <span
      aria-hidden
      className="flex h-5 shrink-0 items-center"
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', cls)} />
    </span>
  )
}

/** Single-line markdown preview rendered via M1's inline renderer.
 * Uses a portal-style `dangerouslySetInnerHTML`-equivalent by
 * appending the fragment into a div ref — this keeps wikilink anchor
 * elements semantically correct (not stuffed into innerHTML) and
 * stays consistent with the editor's rendering path. */
function PreviewLine({ markdown }: { markdown: string }) {
  return (
    <div
      ref={(el) => {
        if (!el) return
        el.innerHTML = ''
        el.appendChild(renderMarkdownToFragment(markdown))
      }}
      className={cn(
        'pl-[14px] truncate text-[12px] text-muted-foreground',
        '[&_.md-wikilink]:text-info [&_.md-link]:text-info',
        // Flatten the renderer's block elements for a one-line row —
        // headings stop being big, lists stop being indented blocks,
        // paragraphs lose their margin. The mini-renderer surfaces
        // its full DOM here only because M3 will re-use the same
        // markup for the expanded view; for the row preview we just
        // want the text + link colouring through.
        '[&_h1]:inline [&_h2]:inline [&_h3]:inline [&_h4]:inline',
        '[&_h5]:inline [&_h6]:inline [&_p]:inline [&_p]:m-0',
        '[&_ul]:inline [&_ul]:list-none [&_ul]:m-0 [&_ul]:p-0',
        '[&_li]:inline [&_li]:after:content-["·_"] [&_li:last-child]:after:content-none',
        '[&_blockquote]:inline [&_blockquote]:m-0',
      )}
    />
  )
}

/** Pick the first non-empty line from the proposal's markdown to use
 * as the row preview. Headings keep their `#` marker because the
 * inline renderer strips it; bullets keep their content. Falls back
 * to an empty string when the change carries no add-able content
 * (delete-only future kind). */
function previewLine(entry: PendingChange): string {
  for (const edit of entry.edits) {
    const text = edit.after ?? edit.before ?? ''
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed) return trimmed
    }
  }
  return ''
}

/** Resolve the doc title for a slug. Returns a fallback when the doc
 * isn't in the catalog — usually means the page got archived after
 * the change was queued; we still want the row to identify it
 * legibly. */
function usePageTitle(slug: string): string {
  return useDocsStore((s) => {
    const doc = s.knownDocs.find((d) => d.slug === slug)
    if (!doc) return slug.slice(0, 8)
    return doc.title?.trim() || doc.type || slug.slice(0, 8)
  })
}

// ── Card ────────────────────────────────────────────────────────

function CommitCard({ commit }: { commit: CommitInfo }) {
  const expanded = useGitStore((s) => s.expandedShas.has(commit.sha))
  const toggle = useGitStore((s) => s.toggleCommitDetail)
  const revert = useGitStore((s) => s.revertCommit)
  const isCommitting = useGitStore((s) => s.status === 'committing')

  const primary = useMemo(() => primaryFileLabel(commit), [commit])
  const { added, removed } = useMemo(() => stat(commit), [commit])
  const source = useMemo(() => commitSource(commit), [commit])

  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => {
          void toggle(commit.sha)
        }}
        className={cn(
          'group relative flex flex-col gap-0.5 rounded-md px-3 py-2 text-left transition-colors',
          'hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none',
        )}
        aria-expanded={expanded}
      >
        <div className="flex items-center gap-1.5 text-sm">
          {expanded ? (
            <IconChevronDown size={12} className="shrink-0 text-muted-foreground" />
          ) : (
            <IconChevronRight size={12} className="shrink-0 text-muted-foreground" />
          )}
          <span className="truncate font-medium">{primary.title}</span>
          <DiffStat added={added} removed={removed} />
        </div>
        <div className="flex items-center justify-between gap-2 pl-[18px] text-xs text-muted-foreground">
          <span className="truncate">{source ?? primary.subtitle}</span>
          <span className="shrink-0">{relativeTime(commit.timestamp)}</span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          disabled={isCommitting}
          onClick={(e) => {
            e.stopPropagation()
            void revert(commit.sha)
          }}
          className="absolute right-1 top-1 h-6 cursor-pointer gap-1 px-1.5 text-[12px] opacity-0 transition-opacity group-hover:opacity-100"
          aria-label="Undo this change"
        >
          <IconArrowBackUp size={12} />
          Undo
        </Button>
      </button>
      {expanded && <CardBody commit={commit} />}
    </div>
  )
}

// ── Expanded body ───────────────────────────────────────────────

function CardBody({ commit }: { commit: CommitInfo }) {
  const detail = useGitStore((s) => s.commitDetails[commit.sha])
  const loading = useGitStore((s) => s.loadingShas.has(commit.sha))

  const parsed = useMemo(
    () => (detail ? parseIngestBody(detail.body) : null),
    [detail],
  )

  // Order files so the card-title's primary file (wiki preferred)
  // shows first, then writing, then daily, then anything else. The
  // user clicked into a "Kate" card so seeing wiki/Kate.md at the
  // top is the natural read; the rest follow as supporting context.
  const orderedFiles: FileDiff[] = useMemo(() => {
    if (!detail) return []
    const priority = (path: string): number => {
      if (path.startsWith('wiki/')) return 0
      if (path.startsWith('writing/')) return 1
      if (path.startsWith('daily/')) return 2
      return 3
    }
    return [...detail.files]
      .filter((f) => f.lines.length > 0)
      .sort((a, b) => priority(a.path) - priority(b.path))
  }, [detail])

  return (
    <div className="ml-[18px] mr-2 mb-2 flex flex-col gap-4 rounded-md border border-border bg-muted/20 px-3 py-3">
      {loading && !detail ? (
        <div className="py-2 text-xs text-muted-foreground">Loading…</div>
      ) : (
        <>
          {parsed?.source && <Section label="Source" body={parsed.source} />}

          {orderedFiles.length > 0 && (
            <Section label={orderedFiles.length === 1 ? 'Changes' : `Changes · ${orderedFiles.length} files`}>
              <div className="flex flex-col gap-3">
                {orderedFiles.map((file) => (
                  <FileBlock key={file.path} file={file} />
                ))}
              </div>
            </Section>
          )}

          {parsed?.why && <Section label="Why" body={parsed.why} />}

          {!detail && (
            <p className="text-xs text-muted-foreground">{commit.subject}</p>
          )}
        </>
      )}
    </div>
  )
}

/** One file's slot inside the Changes section: a small path label
 * sitting above its diff. The label uses the vault-relative path so
 * the user can tell at a glance which doc the swap belongs to —
 * handy when a single chat turn edits multiple files. */
function FileBlock({ file }: { file: FileDiff }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="font-mono text-[11px] text-muted-foreground">
        {file.path}
      </span>
      <DiffBlock file={file} />
    </div>
  )
}

function Section({
  label,
  body,
  children,
}: {
  label: string
  body?: string
  children?: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </h3>
      {body && (
        <p className="whitespace-pre-wrap text-xs leading-relaxed text-foreground">
          {body}
        </p>
      )}
      {children}
    </div>
  )
}

/** Render one file's diff lines git-style: `+` / `-` prefix, green
 * for added, red for removed. Lines are shown in the original hunk
 * order so a modify patch reads `-old → +new` naturally. */
function DiffBlock({ file }: { file: FileDiff }) {
  return (
    <pre className="overflow-x-auto rounded-md border border-border bg-background p-0 font-mono text-[12px] leading-relaxed">
      {file.lines.map((line, i) => (
        <div
          key={i}
          className={cn(
            'flex items-start gap-2 px-3 py-0.5',
            line.kind === 'add'
              ? 'bg-green-500/10 text-green-700 dark:text-green-300'
              : 'bg-red-500/10 text-destructive',
          )}
        >
          <span className="shrink-0 select-none opacity-70">
            {line.kind === 'add' ? '+' : '-'}
          </span>
          <span className="whitespace-pre-wrap break-words">
            {line.text.length === 0 ? ' ' : line.text}
          </span>
        </div>
      ))}
    </pre>
  )
}

function DiffStat({ added, removed }: { added: number; removed: number }) {
  if (added === 0 && removed === 0) return null
  return (
    <span className="shrink-0 font-mono text-[12px]">
      {added > 0 && (
        <span className="text-green-600 dark:text-green-400">+{added}</span>
      )}
      {removed > 0 && (
        <span className="ml-1 text-destructive">-{removed}</span>
      )}
    </span>
  )
}

// ── Helpers ─────────────────────────────────────────────────────

/** Pick the most user-meaningful file in the commit to use as the
 * card title. wiki/ outranks writing/ outranks daily/ — an ingest
 * commit touches both the source (daily) and the destination
 * (wiki), and the destination is what the card is "about". System
 * files (threads/, _system/) only get picked when nothing better
 * is present. */
function primaryFileLabel(commit: CommitInfo): {
  title: string
  subtitle: string
} {
  const file =
    commit.files.find((f) => f.path.startsWith('wiki/')) ??
    commit.files.find((f) => f.path.startsWith('writing/')) ??
    commit.files.find((f) => f.path.startsWith('daily/')) ??
    commit.files[0]
  if (!file) {
    return { title: commit.subject, subtitle: commit.sha.slice(0, 7) }
  }
  const base = file.path.split('/').pop() ?? file.path
  const stem = base.replace(/\.md$/, '').replace(/\.meta\.json$/, '')
  const dir = file.path.includes('/')
    ? file.path.slice(0, file.path.lastIndexOf('/'))
    : ''
  return { title: stem, subtitle: dir || commit.sha.slice(0, 7) }
}

/** Rough card stat: count of touched user-area files, by status.
 * The detail-view diff (git_show) carries the real per-line counts
 * — this is a stand-in for the list view so we don't fetch git_show
 * for every commit just to render a `+1`. */
function stat(commit: CommitInfo): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const f of commit.files) {
    if (
      !f.path.startsWith('wiki/') &&
      !f.path.startsWith('writing/') &&
      !f.path.startsWith('daily/')
    ) {
      continue
    }
    if (f.status === 'A') added += 1
    else if (f.status === 'D') removed += 1
    else added += 1
  }
  return { added, removed }
}

/** Extract a `from daily/...` source label from `ai-edit` commit
 * subjects. Returns null for other commits so the card falls back
 * to the file directory. */
function commitSource(commit: CommitInfo): string | null {
  const m = commit.subject.match(
    /^ai-edit:\s*(?:ingest\s+from\s+|chat:\s*)?([^()]+?)(?:\s*\(.*\))?$/,
  )
  if (!m) return null
  const label = m[1]?.trim()
  return label ? `from ${label}` : null
}

/** Parse the multi-line commit body produced by
 * `buildIngestCommitBody`. Pulls the first `Source:` quote and
 * `Why:` line across all entity blocks. */
function parseIngestBody(body: string): {
  source: string | null
  why: string | null
} {
  if (!body) return { source: null, why: null }
  let source: string | null = null
  let why: string | null = null
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (!source && line.startsWith('Source:')) {
      source = line.slice('Source:'.length).trim().replace(/^"|"$/g, '')
    } else if (!why && line.startsWith('Why:')) {
      why = line.slice('Why:'.length).trim()
    }
    if (source && why) break
  }
  return { source, why }
}

function relativeTime(unixSeconds: number): string {
  const now = Math.floor(Date.now() / 1000)
  const diff = Math.max(0, now - unixSeconds)
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86_400) return `${Math.floor(diff / 3600)}h ago`
  const d = Math.floor(diff / 86_400)
  if (d < 7) return `${d}d ago`
  return new Date(unixSeconds * 1000).toLocaleDateString()
}
