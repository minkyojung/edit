// Horizontal tab strip at the top of the chat panel.
//
// - At most 5 active threads. The [+] button is disabled past that with
//   a tooltip nudging the user to archive one first.
// - Hovering a tab reveals an [×] button that soft-archives the thread.
// - Double-clicking a tab title swaps it for an inline editor.
// - The clock button on the far right opens the archive popover (rendered
//   by the parent — we just emit onOpenArchive when it's clicked).

import { useEffect, useRef, useState } from 'react'
import { IconSparkles, IconPlus, IconX } from '@tabler/icons-react'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { MAX_ACTIVE_THREADS, type ThreadMeta } from './types'
import { ArchivedThreadsPopover } from './ArchivedThreadsPopover'

interface Props {
  active: ThreadMeta[]
  archived: ThreadMeta[]
  activeId: string | null
  onSelect: (id: string) => void
  onCreate: () => void
  onArchive: (id: string) => void
  onRename: (id: string, title: string) => void
  onRestore: (id: string) => { ok: true } | { ok: false; reason: 'limit' | 'not-found' }
  onRestoreLimitReached: () => void
}

export function ThreadTabs({
  active,
  archived,
  activeId,
  onSelect,
  onCreate,
  onArchive,
  onRename,
  onRestore,
  onRestoreLimitReached,
}: Props) {
  const atLimit = active.length >= MAX_ACTIVE_THREADS

  return (
    <TooltipProvider>
      <div className="flex items-center gap-1 border-b border-border bg-background px-2 py-1.5 min-h-[36px]">
        <div className="flex flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {active.map((t) => (
            <Tab
              key={t.id}
              meta={t}
              isActive={t.id === activeId}
              onSelect={() => onSelect(t.id)}
              onArchive={() => onArchive(t.id)}
              onRename={(title) => onRename(t.id, title)}
            />
          ))}

          {/* [+] new thread */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                disabled={atLimit}
                onClick={() => {
                  if (atLimit) return
                  onCreate()
                }}
                className={cn(
                  'flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors',
                  'outline-none focus-visible:ring-3 focus-visible:ring-ring/30',
                  atLimit
                    ? 'cursor-not-allowed opacity-40'
                    : 'hover:bg-accent hover:text-foreground',
                )}
                aria-label="New chat"
              >
                <IconPlus size={14} stroke={1.75} />
              </button>
            </TooltipTrigger>
            {atLimit && (
              <TooltipContent side="bottom">
                Up to {MAX_ACTIVE_THREADS} chats. Archive one to make room.
              </TooltipContent>
            )}
          </Tooltip>
        </div>

        <ArchivedThreadsPopover
          archived={archived}
          activeCount={active.length}
          onRestore={onRestore}
          onLimitReached={onRestoreLimitReached}
        />
      </div>
    </TooltipProvider>
  )
}

interface TabProps {
  meta: ThreadMeta
  isActive: boolean
  onSelect: () => void
  onArchive: () => void
  onRename: (title: string) => void
}

function Tab({ meta, isActive, onSelect, onArchive, onRename }: TabProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(meta.title)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  // Reset draft when meta.title changes externally (Haiku titler) and we're not editing.
  useEffect(() => {
    if (!editing) setDraft(meta.title)
  }, [meta.title, editing])

  const commit = () => {
    const next = draft.trim()
    if (next && next !== meta.title) onRename(next)
    setEditing(false)
  }

  return (
    <div
      role="tab"
      aria-selected={isActive}
      onClick={() => !editing && onSelect()}
      onDoubleClick={() => setEditing(true)}
      className={cn(
        'group flex h-7 max-w-[180px] shrink-0 items-center gap-1.5 rounded-md px-2 text-xs transition-colors',
        isActive
          ? 'bg-accent text-foreground'
          : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
        !editing && 'cursor-pointer',
      )}
    >
      <IconSparkles size={12} stroke={1.75} className="shrink-0" />

      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            else if (e.key === 'Escape') {
              setDraft(meta.title)
              setEditing(false)
            }
          }}
          onClick={(e) => e.stopPropagation()}
          className="min-w-0 flex-1 rounded bg-transparent text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        />
      ) : (
        <span className="min-w-0 flex-1 truncate">
          {meta.title || 'New chat'}
        </span>
      )}

      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onArchive()
        }}
        aria-label="Archive chat"
        className={cn(
          'flex h-4 w-4 shrink-0 items-center justify-center rounded transition-opacity hover:bg-foreground/10',
          'outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
          isActive ? 'opacity-60 hover:opacity-100' : 'opacity-0 group-hover:opacity-60 hover:!opacity-100',
        )}
      >
        <IconX size={12} stroke={2} />
      </button>
    </div>
  )
}
