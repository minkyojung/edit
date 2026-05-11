// Sidebar row + popover that lists archived docs. Mirrors the
// chat ArchivedThreadsPopover in shape — trigger button, list of
// rows with restore + delete-forever, sorted newest first.
//
// Daily entries can't be archived (the store refuses), so this list
// is always writing-only. Cascade-archived groups share a single
// `archivedAt` timestamp; restoring any member restores the whole
// batch via unarchiveDoc.

import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  IconArchive,
  IconRestore,
  IconTrash,
} from '@tabler/icons-react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { SidebarMenuButton } from '@/components/ui/sidebar'
import { useDocsStore, type KnownDoc } from '@/state/docsStore'
import { cn } from '@/lib/utils'
import { ConfirmDeleteForeverDialog } from './ConfirmDeleteForeverDialog'

export function ArchivedDocsPopover() {
  const [open, setOpen] = useState(false)
  const [pendingDeleteSlug, setPendingDeleteSlug] = useState<string | null>(null)
  const [emptyConfirmOpen, setEmptyConfirmOpen] = useState(false)
  const knownDocs = useDocsStore((s) => s.knownDocs)
  const unarchiveDoc = useDocsStore((s) => s.unarchiveDoc)
  const deleteForever = useDocsStore((s) => s.deleteForever)
  const emptyArchive = useDocsStore((s) => s.emptyArchive)

  // Match the sidebar's live width. We can't just use w-(--sidebar-width)
  // because Radix portals the popover to <body>, where the CSS var
  // isn't in scope. Read the actual sidebar element's offsetWidth at
  // open time so a resized / collapsed sidebar still matches.
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [sidebarWidth, setSidebarWidth] = useState<number | null>(null)
  useLayoutEffect(() => {
    if (!open) return
    const sidebar = triggerRef.current?.closest<HTMLElement>(
      '[data-slot="sidebar"]',
    )
    if (sidebar) setSidebarWidth(sidebar.offsetWidth)
  }, [open])

  const archived = useMemo(
    () =>
      knownDocs
        .filter((d): d is KnownDoc & { archivedAt: number } => !!d.archivedAt)
        .sort((a, b) => b.archivedAt - a.archivedAt),
    [knownDocs],
  )

  const count = archived.length

  const pendingDeleteLabel =
    archived.find((d) => d.slug === pendingDeleteSlug)?.title || 'Untitled'

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <SidebarMenuButton
          ref={triggerRef}
          className="text-sidebar-foreground/70"
          aria-label="Archived"
        >
          <IconArchive size={16} stroke={1.5} />
          <span className="flex-1 text-left">Archived</span>
          {count > 0 && (
            <span className="text-xs tabular-nums text-sidebar-foreground/50">
              {count}
            </span>
          )}
        </SidebarMenuButton>
      </PopoverTrigger>

      <PopoverContent
        side="top"
        align="start"
        sideOffset={6}
        // Width matches the live sidebar element. Radix portals the
        // popover to <body> so a CSS var would fall out of scope —
        // we read the actual sidebar offsetWidth at open time and
        // apply it inline so resized / themed sidebars still match.
        style={sidebarWidth ? { width: sidebarWidth } : undefined}
        className="gap-0 rounded-xl p-1.5"
      >
        <div className="flex items-center gap-1 px-2 py-1">
          <span className="flex-1 text-xs font-medium uppercase tracking-wide text-muted-foreground/80">
            Archived
          </span>
          <button
            type="button"
            disabled={count === 0}
            onClick={() => setEmptyConfirmOpen(true)}
            aria-label="Empty archive"
            title="Empty archive"
            className={cn(
              'flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors',
              'outline-none hover:bg-destructive/10 hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring/40',
              'disabled:pointer-events-none disabled:opacity-40',
            )}
          >
            <IconTrash size={14} stroke={1.75} />
          </button>
        </div>

        {count === 0 ? (
          <div className="px-2.5 py-3 text-xs text-muted-foreground">
            No archived notes.
          </div>
        ) : (
          <ul className="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
            {archived.map((d) => (
              <ArchivedRow
                key={d.slug}
                doc={d}
                onRestore={() => {
                  unarchiveDoc(d.slug)
                  if (archived.length === 1) setOpen(false)
                }}
                onDelete={() => setPendingDeleteSlug(d.slug)}
              />
            ))}
          </ul>
        )}
      </PopoverContent>

      <ConfirmDeleteForeverDialog
        open={pendingDeleteSlug !== null}
        onOpenChange={(o) => {
          if (!o) setPendingDeleteSlug(null)
        }}
        title="Delete forever?"
        description={`"${pendingDeleteLabel}" will be permanently removed. This can't be undone.`}
        confirmLabel="Delete forever"
        onConfirm={async () => {
          if (!pendingDeleteSlug) return
          await deleteForever(pendingDeleteSlug).catch((err) =>
            console.error('[archive] deleteForever failed', err),
          )
        }}
      />

      <ConfirmDeleteForeverDialog
        open={emptyConfirmOpen}
        onOpenChange={setEmptyConfirmOpen}
        title="Empty archive?"
        description={
          count === 1
            ? '1 archived note will be permanently removed. This can’t be undone.'
            : `${count} archived notes will be permanently removed. This can’t be undone.`
        }
        confirmLabel="Empty archive"
        onConfirm={async () => {
          await emptyArchive().catch((err) =>
            console.error('[archive] emptyArchive failed', err),
          )
          setOpen(false)
        }}
      />
    </Popover>
  )
}

interface RowProps {
  doc: KnownDoc & { archivedAt: number }
  onRestore: () => void
  onDelete: () => void
}

function ArchivedRow({ doc, onRestore, onDelete }: RowProps) {
  return (
    <li className="group relative flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-accent">
      <span className="min-w-0 flex-1 truncate text-foreground">
        {doc.title || 'Untitled'}
      </span>
      {/* Time and hover-actions occupy the same right slot — time
          fades out under the row's hover so the buttons can take
          over without shifting the layout. */}
      <span className="shrink-0 text-right text-xs tabular-nums text-muted-foreground transition-opacity group-hover:opacity-0">
        {formatRelative(doc.archivedAt)}
      </span>
      <div className="absolute inset-y-0 right-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <button
          type="button"
          onClick={onRestore}
          aria-label="Restore"
          title="Restore"
          className={cn(
            'flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors',
            'outline-none hover:bg-foreground/10 hover:text-foreground',
            'focus-visible:ring-2 focus-visible:ring-ring/40',
          )}
        >
          <IconRestore size={14} stroke={1.75} />
        </button>
        <button
          type="button"
          onClick={onDelete}
          aria-label="Delete forever"
          title="Delete forever"
          className={cn(
            'flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors',
            'outline-none hover:bg-destructive/10 hover:text-destructive',
            'focus-visible:ring-2 focus-visible:ring-ring/40',
          )}
        >
          <IconTrash size={14} stroke={1.75} />
        </button>
      </div>
    </li>
  )
}

function formatRelative(ts: number): string {
  const diffMs = Date.now() - ts
  const m = Math.round(diffMs / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  if (d < 30) return `${d}d ago`
  const mo = Math.round(d / 30)
  return `${mo}mo ago`
}
