// Dropdown picker at the top of the chat panel. Replaces the horizontal
// ThreadTabs strip: the chat panel is too narrow to comfortably show 5
// tabs side-by-side, and rename/archive being hover-only hurt
// discoverability. The picker shows only the active thread title in the
// header row; clicking opens a Radix popover with active + archived in a
// single list, plus a [+ New chat] action.
//
// Same props shape as ThreadTabs so ChatPanel only swaps the import + JSX
// call. Data-layer hooks (useThreads, useActiveThread) are untouched.

import { useEffect, useRef, useState } from 'react'
import {
  IconChevronDown,
  IconMessageCircleFilled,
  IconPlus,
  IconRestore,
  IconX,
} from '@tabler/icons-react'
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
import { cn } from '@/lib/utils'
import { formatRelative } from '@/lib/formatRelative'
import { MAX_ACTIVE_THREADS, type ThreadMeta } from './types'

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

export function ThreadPicker({
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
  const [open, setOpen] = useState(false)
  const atLimit = active.length >= MAX_ACTIVE_THREADS
  const activeThread = active.find((t) => t.id === activeId) ?? null

  const handleSelect = (id: string) => {
    onSelect(id)
    setOpen(false)
  }

  const handleCreate = () => {
    if (atLimit) return
    onCreate()
    setOpen(false)
  }

  const handleRestore = (id: string) => {
    const result = onRestore(id)
    if (!result.ok && result.reason === 'limit') {
      onRestoreLimitReached()
      return
    }
    if (result.ok) setOpen(false)
  }

  return (
    <TooltipProvider>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              // min-w-0 lets the trigger shrink inside its flex parent so the
              // title span's `truncate` actually engages — without it the
              // button falls back to min-content width and a long title
              // pushes the chevron out of the panel.
              'flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 text-left text-sm font-medium',
              'text-foreground outline-none transition-colors',
              'hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring/40',
            )}
            aria-label="Switch chat"
          >
            <IconMessageCircleFilled size={14} className="shrink-0 opacity-70" />
            <span className="min-w-0 flex-1 truncate">
              {activeThread?.title || 'New chat'}
            </span>
            <IconChevronDown
              size={14}
              stroke={1.75}
              className={cn(
                'shrink-0 text-muted-foreground transition-transform',
                open && 'rotate-180',
              )}
            />
          </button>
        </PopoverTrigger>

        <PopoverContent
          align="start"
          sideOffset={6}
          className="w-80 gap-0 rounded-2xl p-1.5"
        >
          {active.length > 0 && (
            <ul className="flex flex-col gap-0.5">
              {active.map((t) => (
                <ActiveRow
                  key={t.id}
                  meta={t}
                  isActive={t.id === activeId}
                  onSelect={() => handleSelect(t.id)}
                  onArchive={() => onArchive(t.id)}
                  onRename={(title) => onRename(t.id, title)}
                />
              ))}
            </ul>
          )}

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={handleCreate}
                disabled={atLimit}
                className={cn(
                  'mt-0.5 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors outline-none',
                  'focus-visible:ring-3 focus-visible:ring-ring/30',
                  atLimit
                    ? 'cursor-not-allowed text-muted-foreground opacity-60'
                    : 'text-foreground hover:bg-accent',
                )}
              >
                <IconPlus size={14} stroke={1.75} className="shrink-0 opacity-70" />
                <span className="min-w-0 flex-1">New chat</span>
              </button>
            </TooltipTrigger>
            {atLimit && (
              <TooltipContent side="bottom">
                Up to {MAX_ACTIVE_THREADS} chats. Archive one to make room.
              </TooltipContent>
            )}
          </Tooltip>

          {archived.length > 0 && (
            <>
              <div className="my-1 h-px bg-border" />
              <div className="px-2 py-1 text-xs font-medium text-muted-foreground">
                Archived
              </div>
              <ul className="flex flex-col gap-0.5">
                {archived.map((t) => (
                  <li key={t.id}>
                    <button
                      type="button"
                      onClick={() => handleRestore(t.id)}
                      disabled={atLimit}
                      className="group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/30 disabled:pointer-events-none disabled:opacity-50"
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
              {atLimit && (
                <div className="px-2.5 py-1 text-xs text-muted-foreground">
                  Already at {MAX_ACTIVE_THREADS} active chats. Archive one to restore.
                </div>
              )}
            </>
          )}
        </PopoverContent>
      </Popover>
    </TooltipProvider>
  )
}

interface ActiveRowProps {
  meta: ThreadMeta
  isActive: boolean
  onSelect: () => void
  onArchive: () => void
  onRename: (title: string) => void
}

function ActiveRow({ meta, isActive, onSelect, onArchive, onRename }: ActiveRowProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(meta.title)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  // External title updates (Haiku titler) shouldn't clobber an in-flight edit.
  useEffect(() => {
    if (!editing) setDraft(meta.title)
  }, [meta.title, editing])

  const commit = () => {
    const next = draft.trim()
    if (next && next !== meta.title) onRename(next)
    setEditing(false)
  }

  return (
    <li>
      <div
        role="button"
        tabIndex={editing ? -1 : 0}
        onClick={() => {
          if (editing) return
          onSelect()
        }}
        onDoubleClick={(e) => {
          e.stopPropagation()
          setEditing(true)
        }}
        onKeyDown={(e) => {
          if (editing) return
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onSelect()
          }
        }}
        className={cn(
          'group flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors outline-none',
          'focus-visible:ring-3 focus-visible:ring-ring/30',
          isActive ? 'bg-accent text-foreground' : 'text-foreground hover:bg-accent/60',
        )}
      >
        <IconMessageCircleFilled size={14} className="shrink-0 opacity-70" />

        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              // Stop Radix from interpreting these as popover navigation /
              // dismiss. Escape inside a Popover closes it by default; we
              // want it to cancel rename without dismissing the picker.
              e.stopPropagation()
              if (e.key === 'Enter') {
                e.preventDefault()
                commit()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                setDraft(meta.title)
                setEditing(false)
              }
            }}
            onClick={(e) => e.stopPropagation()}
            className="min-w-0 flex-1 rounded bg-transparent text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          />
        ) : (
          <span className="min-w-0 flex-1 truncate">
            {meta.title || 'New chat'}
          </span>
        )}

        <span
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation()
            onArchive()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              e.stopPropagation()
              onArchive()
            }
          }}
          aria-label="Archive chat"
          className={cn(
            'flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors hover:bg-foreground/10',
            'outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
            'text-muted-foreground hover:text-foreground',
          )}
        >
          <IconX size={12} stroke={2} />
        </span>
      </div>
    </li>
  )
}
