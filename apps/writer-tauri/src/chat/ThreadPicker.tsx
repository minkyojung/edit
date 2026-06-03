// Dropdown picker at the top of the chat panel. Replaces the horizontal
// ThreadTabs strip: the chat panel is too narrow to comfortably show 5
// tabs side-by-side, and rename/archive being hover-only hurt
// discoverability. The picker shows only the active thread title in the
// header row; clicking opens a DropdownMenu with active + archived in a
// single list, plus a [+ New chat] action.
//
// Built on the shared DropdownMenu primitive so padding, radius,
// separator, and icon stroke flow from the same tokens as the sidebar
// account menu and other menus across the app. The active thread is
// signalled by text color contrast (inactive rows use
// `text-muted-foreground`, active stays at full `text-foreground`) —
// no built-in check indicator competes with the row's archive button.

import { useEffect, useRef, useState } from 'react'
import {
  IconChevronDown,
  IconMessageCircleFilled,
  IconPencil,
  IconPlus,
  IconRestore,
  IconX,
} from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
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
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            // min-w-0 lets the trigger shrink inside its flex parent so the
            // title span's `truncate` actually engages — without it the
            // button falls back to min-content width and a long title
            // pushes the chevron out of the panel.
            className="min-w-0 flex-1 justify-start self-center px-2"
            aria-label="Switch chat"
          >
            <IconMessageCircleFilled size={16} stroke={1.5} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate text-left">
              {activeThread?.title || 'New chat'}
            </span>
            <IconChevronDown
              size={14}
              stroke={1.5}
              className={cn(
                'shrink-0 text-muted-foreground transition-transform',
                open && 'rotate-180',
              )}
            />
          </Button>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="start" className="w-80">
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

          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuItem onSelect={handleCreate} disabled={atLimit}>
                <IconPlus size={16} stroke={1.5} />
                New chat
              </DropdownMenuItem>
            </TooltipTrigger>
            {atLimit && (
              <TooltipContent side="bottom">
                Up to {MAX_ACTIVE_THREADS} chats. Archive one to make room.
              </TooltipContent>
            )}
          </Tooltip>

          {archived.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs text-muted-foreground font-normal">
                Archived
              </DropdownMenuLabel>
              {archived.map((t) => (
                <DropdownMenuItem
                  key={t.id}
                  onSelect={() => handleRestore(t.id)}
                  disabled={atLimit}
                >
                  <span className="min-w-0 flex-1 truncate">
                    {t.title || 'New chat'}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatRelative(t.archivedAt ?? t.updatedAt)}
                  </span>
                  <IconRestore size={16} stroke={1.5} className="text-muted-foreground" />
                </DropdownMenuItem>
              ))}
              {atLimit && (
                <div className="px-3 py-1.5 text-xs text-muted-foreground">
                  Already at {MAX_ACTIVE_THREADS} active chats. Archive one to restore.
                </div>
              )}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
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
    <DropdownMenuItem
      // Block row select / menu close while editing — Enter / outside
      // clicks should commit the rename, not switch threads or dismiss.
      onSelect={(e) => {
        if (editing) {
          e.preventDefault()
          return
        }
        onSelect()
      }}
      className={cn(!isActive && 'text-muted-foreground')}
    >
      <IconMessageCircleFilled size={16} stroke={1.5} className="shrink-0" />

      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            // Stop Radix DropdownMenu from reading these as list nav
            // (↑↓), typeahead, or dismiss (Escape).
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
          className="min-w-0 flex-1 rounded-md bg-transparent text-sm font-medium text-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
        />
      ) : (
        <span className="min-w-0 flex-1 truncate">
          {meta.title || 'New chat'}
        </span>
      )}

      {/* Rename button — clicked separately so the row's onSelect
          (which would switch threads + close menu) doesn't fire. */}
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={(e) => {
          e.stopPropagation()
          setEditing(true)
        }}
        aria-label="Rename chat"
        className="text-muted-foreground hover:text-foreground"
      >
        <IconPencil size={14} stroke={1.5} />
      </Button>

      {/* Archive button — same propagation guard. */}
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={(e) => {
          e.stopPropagation()
          onArchive()
        }}
        aria-label="Archive chat"
        className="text-muted-foreground hover:text-foreground"
      >
        <IconX size={14} stroke={1.5} />
      </Button>
    </DropdownMenuItem>
  )
}
