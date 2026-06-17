// Right-side panel: the vault's "Changes & backup" hub.
//
// Shows every applied (committed) change to user content — both AI edits
// (`ai-edit:` commits, tagged with an "AI" badge) and the user's own
// snapshots — since the last review. Expand a card for the per-file diff,
// undo if needed. The footer carries the backup status (auto-push state)
// plus "Save snapshot" and "Mark all reviewed". Proposing/deciding an AI
// change still happens at edit time in the inline Keep/Reject widget; this
// panel is the after-the-fact record.
//
// (Snapshot + backup also live in the profile dropdown so they're
// reachable when the right column is showing chat, not this panel.)
//
// File-selection rule for cards: wiki/ → writing/ → daily/. An LLM ingest
// commit usually touches both the daily (where the user wrote) and the
// wiki page (where the LLM filed). The card is "about" the destination —
// the wiki page — so we prefer that for the title and the diff.

import { useEffect, useMemo } from 'react'
import {
  IconArrowBackUp,
  IconChevronDown,
  IconChevronRight,
  IconCloud,
  IconCloudUpload,
  IconHistory,
} from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useGitStore, isAiEditCommit } from '@/state/gitStore'
import { useSyncStore, type SyncStatus } from '@/state/syncStore'
import { backupToGitHub, pushVault } from '@/lib/vaultBackup'
import type { CommitInfo, FileDiff } from '@/lib/git'
import { DiffBlock } from '@/components/DiffBlock'
import { cn } from '@/lib/utils'

export function ReviewPanel() {
  // All applied changes to user content (AI + the user's own snapshots).
  // gitStore.activity is already filtered to user-visible commits; we show
  // it as-is and tag AI ones with a badge (see CommitCard).
  // Changes since the last backup (origin..HEAD) — both AI edits and the
  // user's own snapshots. gitStore.activity now tracks "unpushed"; AI ones
  // get a badge (see CommitCard). Pushing clears this.
  const activity = useGitStore((s) => s.activity)
  const commitImmediate = useGitStore((s) => s.commitImmediate)
  const dirtyCount = useGitStore((s) => s.dirtyPaths.size)
  const isCommitting = useGitStore((s) => s.status === 'committing')

  const syncStatus = useSyncStore((s) => s.status)
  const repoFullName = useSyncStore((s) => s.repoFullName)

  // Refresh on mount so the panel reflects the latest state even if
  // the user opened it after a long gap.
  useEffect(() => {
    void useGitStore.getState().refreshActivity()
  }, [])

  const unpushed = activity.length
  const hasActivity = unpushed > 0
  const canSnapshot = dirtyCount > 0 && !isCommitting

  return (
    <div className="flex h-full flex-col">
      <ScrollArea className="min-h-0 flex-1">
        {!hasActivity ? (
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
              {repoFullName ? 'All backed up' : 'No changes yet'}
            </p>
            <p className="max-w-xs text-center text-[14px] text-muted-foreground">
              {repoFullName
                ? 'Every change is saved to GitHub.'
                : 'Edits will show here, ready to back up.'}
            </p>
          </div>
        ) : (
          // Top padding clears the overlay header (content scrolls behind it).
          <div className="flex flex-col pt-[var(--header-h)]">
            <HistorySection commits={activity} />
          </div>
        )}
      </ScrollArea>

      <div className="shrink-0 flex flex-col gap-2 bg-transparent px-4 py-3 shadow-[inset_0_1px_0_var(--border)]">
        <BackupStatus status={syncStatus} repoFullName={repoFullName} unpushed={unpushed} />
        <div className="flex gap-2">
          {/* Save snapshot commits dirty edits → they appear above as
              "to back up"; Back up then pushes them to GitHub. */}
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            disabled={!canSnapshot}
            onClick={() => {
              void commitImmediate()
            }}
          >
            Save snapshot{dirtyCount > 0 ? ` (${dirtyCount})` : ''}
          </Button>
          <BackUpButton
            repoFullName={repoFullName}
            status={syncStatus}
            unpushed={unpushed}
          />
        </div>
      </div>
    </div>
  )
}

/** The footer's primary action. Before the first backup it sets one up;
 * after, it pushes the unpushed changes (and doubles as retry on failure).
 * Push is fully manual — there is no auto-push. */
function BackUpButton({
  repoFullName,
  status,
  unpushed,
}: {
  repoFullName: string | null
  status: SyncStatus
  unpushed: number
}) {
  const busy = status === 'pushing' || status === 'backing-up'
  if (!repoFullName) {
    return (
      <Button
        variant="default"
        size="sm"
        className="flex-1"
        disabled={busy}
        onClick={() => void backupToGitHub()}
      >
        Back up to GitHub
      </Button>
    )
  }
  return (
    <Button
      variant="default"
      size="sm"
      className="flex-1"
      disabled={busy || unpushed === 0}
      onClick={() => void pushVault()}
    >
      {busy ? 'Backing up…' : `Back up${unpushed > 0 ? ` · ${unpushed}` : ''}`}
    </Button>
  )
}

/** Text-only backup status line above the footer buttons. */
function BackupStatus({
  status,
  repoFullName,
  unpushed,
}: {
  status: SyncStatus
  repoFullName: string | null
  unpushed: number
}) {
  if (!repoFullName) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <IconCloudUpload size={14} />
        Not backed up yet
      </span>
    )
  }
  const { label, tone } = backupLabel(status, unpushed)
  return (
    <span className={cn('flex items-center gap-1.5 text-xs', tone)}>
      <IconCloud size={14} />
      {label}
    </span>
  )
}

function backupLabel(
  status: SyncStatus,
  unpushed: number,
): { label: string; tone: string } {
  switch (status) {
    case 'pushing':
    case 'backing-up':
      return { label: 'Backing up…', tone: 'text-muted-foreground' }
    case 'error':
      return { label: 'Backup needs attention', tone: 'text-destructive' }
    case 'pending':
      return { label: "Offline — couldn't back up", tone: 'text-muted-foreground' }
    default:
      return unpushed > 0
        ? {
            label: `${unpushed} change${unpushed === 1 ? '' : 's'} to back up`,
            tone: 'text-muted-foreground',
          }
        : { label: 'Backed up', tone: 'text-muted-foreground' }
  }
}

function HistorySection({ commits }: { commits: CommitInfo[] }) {
  return (
    <section className="flex flex-col">
      <h3 className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Changes
      </h3>
      <div className="flex flex-col">
        {commits.map((commit) => (
          <CommitCard key={commit.sha} commit={commit} />
        ))}
      </div>
    </section>
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
          {isAiEditCommit(commit) && (
            <span className="shrink-0 rounded bg-info/15 px-1 text-[10px] font-semibold uppercase tracking-wide text-info">
              AI
            </span>
          )}
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
      <DiffBlock lines={file.lines} />
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

function DiffStat({ added, removed }: { added: number; removed: number }) {
  if (added === 0 && removed === 0) return null
  return (
    <span className="shrink-0 font-mono text-[12px]">
      {added > 0 && (
        <span className="text-success">+{added}</span>
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
