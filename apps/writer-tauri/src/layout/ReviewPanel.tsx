// Right-side panel surface for reviewing recent changes.
//
// One view, expandable cards. The list shows a minimal header per
// commit (entity + diff stat + source + time); clicking a card
// expands an inline body with Source / Added / Why pulled from the
// commit message + diff. Multiple cards can be open at once so the
// user can scan related changes without navigating away.
//
// File-selection rule: wiki/ → writing/ → daily/. An LLM ingest
// commit usually touches both the daily (where the user wrote) and
// the wiki page (where the LLM filed). The card is "about" the
// destination — the wiki page — so we prefer that for the title
// and the "Added" diff.

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
import type { CommitInfo, FileDiff } from '@/lib/git'
import { cn } from '@/lib/utils'

export function ReviewPanel() {
  const activity = useGitStore((s) => s.activity)
  const markAllReviewed = useGitStore((s) => s.markAllReviewed)

  // Refresh on mount so the panel reflects the latest state even if
  // the user opened it after a long gap.
  useEffect(() => {
    void useGitStore.getState().refreshActivity()
  }, [])

  const hasActivity = activity.length > 0

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-col gap-0.5 bg-transparent px-4 py-3 shadow-[inset_0_-1px_0_var(--border)]">
        <h2 className="text-[15px] font-semibold text-foreground">Recent changes</h2>
        {hasActivity && (
          <p className="text-[13px] text-muted-foreground">
            {`${activity.length} change${activity.length === 1 ? '' : 's'} since you last reviewed`}
          </p>
        )}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {hasActivity ? (
          <div className="flex flex-col p-2">
            {activity.map((commit) => (
              <CommitCard key={commit.sha} commit={commit} />
            ))}
          </div>
        ) : (
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
