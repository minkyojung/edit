// Clock-button + popover that lists archived threads for the current
// document. Each row shows the title, a relative timestamp, and a
// restore button. The popover is anchored to the trigger so it drops
// down right under the button.

import { useState } from 'react'
import { IconHistory, IconRestore } from '@tabler/icons-react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { MAX_ACTIVE_THREADS, type ThreadMeta } from './types'

interface Props {
  archived: ThreadMeta[]                                       // sorted newest first
  activeCount: number
  onRestore: (id: string) => { ok: true } | { ok: false; reason: 'limit' | 'not-found' }
  onLimitReached: () => void                                   // toast / nudge — caller decides
}

export function ArchivedThreadsPopover({
  archived,
  activeCount,
  onRestore,
  onLimitReached,
}: Props) {
  const [open, setOpen] = useState(false)
  if (archived.length === 0) return null

  const handleRestore = (id: string) => {
    const result = onRestore(id)
    if (!result.ok && result.reason === 'limit') {
      onLimitReached()
      return
    }
    if (result.ok) setOpen(false)
  }

  return (
    <TooltipProvider>
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                aria-label="Archived chats"
              >
                <IconHistory size={14} stroke={1.75} />
              </button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">Archived chats</TooltipContent>
        </Tooltip>

        <PopoverContent
          align="end"
          sideOffset={6}
          className="w-80 gap-0 rounded-2xl p-1.5"
        >
          <ul className="flex flex-col gap-0.5">
            {archived.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => handleRestore(t.id)}
                  disabled={activeCount >= MAX_ACTIVE_THREADS}
                  className="group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span className="min-w-0 flex-1 truncate text-foreground">
                    {t.title || 'New chat'}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatRelative(t.archivedAt ?? t.updatedAt)}
                  </span>
                  <IconRestore
                    size={14}
                    stroke={1.75}
                    className="shrink-0 text-muted-foreground transition-colors group-hover:text-foreground"
                  />
                </button>
              </li>
            ))}
          </ul>
          {activeCount >= MAX_ACTIVE_THREADS && (
            <div className="px-2.5 py-1.5 text-xs text-muted-foreground">
              Already at {MAX_ACTIVE_THREADS} active chats. Archive one to restore.
            </div>
          )}
        </PopoverContent>
      </Popover>
    </TooltipProvider>
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
