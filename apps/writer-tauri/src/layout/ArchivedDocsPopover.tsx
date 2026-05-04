// Sidebar row + popover that lists archived docs. Mirrors the
// chat ArchivedThreadsPopover in shape — trigger button, list of
// rows with restore + delete-forever, sorted newest first.
//
// Daily entries can't be archived (the store refuses), so this list
// is always writing-only. Cascade-archived groups share a single
// `archivedAt` timestamp; restoring any member restores the whole
// batch via unarchiveDoc.

import { useMemo, useState } from 'react'
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

export function ArchivedDocsPopover() {
  const [open, setOpen] = useState(false)
  const knownDocs = useDocsStore((s) => s.knownDocs)
  const unarchiveDoc = useDocsStore((s) => s.unarchiveDoc)
  const deleteForever = useDocsStore((s) => s.deleteForever)
  const emptyArchive = useDocsStore((s) => s.emptyArchive)

  const archived = useMemo(
    () =>
      knownDocs
        .filter((d): d is KnownDoc & { archivedAt: number } => !!d.archivedAt)
        .sort((a, b) => b.archivedAt - a.archivedAt),
    [knownDocs],
  )

  const count = archived.length

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <SidebarMenuButton
          className="h-8 px-2 text-[13px] font-medium text-muted-foreground hover:text-foreground"
          aria-label="Archived"
        >
          <IconArchive size={16} stroke={1.5} />
          <span className="flex-1 text-left">Archived</span>
          {count > 0 && (
            <span className="text-xs tabular-nums text-muted-foreground/70">
              {count}
            </span>
          )}
        </SidebarMenuButton>
      </PopoverTrigger>

      <PopoverContent
        side="top"
        align="start"
        sideOffset={6}
        className="w-72 gap-0 rounded-xl p-1.5"
      >
        {count === 0 ? (
          <div className="px-2.5 py-3 text-xs text-muted-foreground">
            No archived notes.
          </div>
        ) : (
          <>
            <ul className="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
              {archived.map((d) => (
                <ArchivedRow
                  key={d.slug}
                  doc={d}
                  onRestore={() => {
                    unarchiveDoc(d.slug)
                    if (archived.length === 1) setOpen(false)
                  }}
                  onDelete={() => {
                    deleteForever(d.slug).catch((err) =>
                      console.error('[archive] deleteForever failed', err),
                    )
                  }}
                />
              ))}
            </ul>
            <div className="mt-1 flex items-center justify-end border-t pt-1">
              <button
                type="button"
                onClick={() => {
                  emptyArchive().catch((err) =>
                    console.error('[archive] emptyArchive failed', err),
                  )
                  setOpen(false)
                }}
                className={cn(
                  'rounded-md px-2 py-1 text-xs font-medium text-destructive transition-colors',
                  'outline-none hover:bg-destructive/10 focus-visible:ring-2 focus-visible:ring-ring/40',
                )}
              >
                Empty archive
              </button>
            </div>
          </>
        )}
      </PopoverContent>
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
    <li className="group flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-accent">
      <span className="min-w-0 flex-1 truncate text-foreground">
        {doc.title || 'Untitled'}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">
        {formatRelative(doc.archivedAt)}
      </span>
      <button
        type="button"
        onClick={onRestore}
        aria-label="Restore"
        title="Restore"
        className={cn(
          'flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors',
          'opacity-0 group-hover:opacity-100 hover:bg-foreground/10 hover:text-foreground',
          'outline-none focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/40',
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
          'opacity-0 group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive',
          'outline-none focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/40',
        )}
      >
        <IconTrash size={14} stroke={1.75} />
      </button>
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
