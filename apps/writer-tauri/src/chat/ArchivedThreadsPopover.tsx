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
import { Button } from '@/components/ui/button'
import { formatRelative } from '@/lib/formatRelative'
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
              <Button
                variant="iconGhost"
                size="icon-sm"
                className="shrink-0 self-center"
                aria-label="Archived chats"
              >
                <IconHistory size={16} stroke={1.75} />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">Archived chats</TooltipContent>
        </Tooltip>

        <PopoverContent
          align="end"
          sideOffset={6}
          className="w-80 gap-0 rounded-2xl p-1.5"
        >
          <ul className="flex max-h-[60vh] flex-col gap-0.5 overflow-y-auto">
            {archived.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => handleRestore(t.id)}
                  disabled={activeCount >= MAX_ACTIVE_THREADS}
                  className="group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-body transition-colors outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/30 disabled:pointer-events-none disabled:opacity-50"
                >
                  <span className="min-w-0 flex-1 truncate text-foreground">
                    {t.title || 'New chat'}
                  </span>
                  <span className="shrink-0 text-footnote text-muted-foreground">
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
            <div className="px-2.5 py-1.5 text-footnote text-muted-foreground">
              Already at {MAX_ACTIVE_THREADS} active chats. Archive one to restore.
            </div>
          )}
        </PopoverContent>
      </Popover>
    </TooltipProvider>
  )
}

