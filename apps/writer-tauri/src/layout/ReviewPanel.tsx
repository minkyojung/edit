// Right-side panel surface for reviewing recent changes — the
// activity feed that replaces the old `ActivityView` modal. Same
// data and per-commit affordances (Undo, file list), but mounted
// inside the resizable right column alongside the chat surface so
// the user can pivot between writing and reviewing without leaving
// their context.
//
// Why a panel and not a modal:
//   - Reviewing a long history doesn't benefit from a focal modal
//     that grabs the editor's surface; the user often wants to
//     glance at a change, return to the editor, refine, glance back.
//   - The right column already has a "secondary surface" role
//     (chat). Reusing the space keeps the layout discoverable —
//     one place to look when something isn't the editor.
//   - Once Phase 2 adds inline diff + rationale, the panel needs
//     more vertical room than a modal comfortably gives.

import { useEffect } from 'react'
import { IconArrowBackUp, IconClock } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { useGitStore } from '@/state/gitStore'
import type { CommitInfo, FileChange } from '@/lib/git'
import { cn } from '@/lib/utils'

export function ReviewPanel() {
  const activity = useGitStore((s) => s.activity)
  const markAllReviewed = useGitStore((s) => s.markAllReviewed)

  // Refresh on mount so the panel reflects the latest state even if
  // the user opened it after a long gap. The store's 30 s background
  // poll keeps it warm during active use, but a fresh fetch on the
  // explicit user gesture (clicking Review) is cheap and removes any
  // "did it update?" doubt.
  useEffect(() => {
    void useGitStore.getState().refreshActivity()
  }, [])

  const hasActivity = activity.length > 0

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-col gap-1 border-b border-border px-4 py-3">
        <h2 className="text-sm font-medium">Recent changes</h2>
        <p className="text-xs text-muted-foreground">
          {hasActivity
            ? `${activity.length} change${activity.length === 1 ? '' : 's'} since you last reviewed`
            : "You're caught up — nothing new since the last review."}
        </p>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {hasActivity ? (
          <div className="flex flex-col gap-2 p-3">
            {activity.map((commit) => (
              <CommitCard key={commit.sha} commit={commit} />
            ))}
          </div>
        ) : (
          <div className="flex items-center justify-center px-4 py-12 text-center text-xs text-muted-foreground">
            No activity to show.
          </div>
        )}
      </ScrollArea>

      <div className="shrink-0 border-t border-border px-4 py-3">
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

function CommitCard({ commit }: { commit: CommitInfo }) {
  const revert = useGitStore((s) => s.revertCommit)
  const isCommitting = useGitStore((s) => s.status === 'committing')

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-card p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{commit.subject}</div>
          <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
            <IconClock size={12} />
            <span>{relativeTime(commit.timestamp)}</span>
            <span className="font-mono">· {commit.sha.slice(0, 7)}</span>
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          disabled={isCommitting}
          onClick={() => {
            void revert(commit.sha)
          }}
          className="shrink-0"
          aria-label="Revert this change"
        >
          <IconArrowBackUp size={14} className="mr-1" />
          Undo
        </Button>
      </div>
      {commit.files.length > 0 && (
        <>
          <Separator />
          <FileList files={commit.files} />
        </>
      )}
    </div>
  )
}

function FileList({ files }: { files: FileChange[] }) {
  // Cap the list so a mass-revert commit doesn't push the card off
  // screen. Overflow collapses to a `+N more` line.
  const VISIBLE = 5
  const shown = files.slice(0, VISIBLE)
  const overflow = files.length - shown.length
  return (
    <ul className="flex flex-col gap-0.5 text-xs">
      {shown.map((f, i) => (
        <li key={`${f.path}-${i}`} className="flex items-center gap-2">
          <StatusChip status={f.status} />
          <span className="truncate font-mono text-muted-foreground">{f.path}</span>
        </li>
      ))}
      {overflow > 0 && (
        <li className="pl-7 text-muted-foreground">+ {overflow} more</li>
      )}
    </ul>
  )
}

function StatusChip({ status }: { status: string }) {
  const colour =
    status === 'A'
      ? 'text-green-600 dark:text-green-400'
      : status === 'D'
        ? 'text-destructive'
        : status === 'R'
          ? 'text-blue-600 dark:text-blue-400'
          : 'text-muted-foreground'
  return (
    <span
      className={cn('w-5 shrink-0 font-mono text-[10px] uppercase', colour)}
      aria-hidden
    >
      {status}
    </span>
  )
}

function relativeTime(unixSeconds: number): string {
  const now = Math.floor(Date.now() / 1000)
  const diff = Math.max(0, now - unixSeconds)
  if (diff < 60) return 'just now'
  if (diff < 3600) {
    const m = Math.floor(diff / 60)
    return `${m} minute${m === 1 ? '' : 's'} ago`
  }
  if (diff < 86_400) {
    const h = Math.floor(diff / 3600)
    return `${h} hour${h === 1 ? '' : 's'} ago`
  }
  const d = Math.floor(diff / 86_400)
  if (d < 7) return `${d} day${d === 1 ? '' : 's'} ago`
  return new Date(unixSeconds * 1000).toLocaleDateString()
}
