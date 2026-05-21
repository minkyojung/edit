// Dropdown picker at the top of the chat panel. Replaces the horizontal
// ThreadTabs strip: the chat panel is too narrow to comfortably show 5
// tabs side-by-side, and rename/archive being hover-only hurt
// discoverability. The picker shows only the active thread title in the
// header row; clicking opens a Radix popover with active + archived in a
// single list, plus a [+ New chat] action.
//
// Built on Popover + Command (cmdk). Items reuse CommandItem so
// padding / typography / focus styling flow from the design system
// primitives rather than ad-hoc className strings. The active thread is
// signalled by `data-checked`, which renders the built-in check icon on
// the right edge of the row.

import { useEffect, useRef, useState } from 'react'
import {
  IconChevronDown,
  IconMessageCircleFilled,
  IconPlus,
  IconRestore,
  IconX,
} from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandGroup,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command'
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
          <Button
            variant="ghost"
            size="sm"
            // min-w-0 lets the trigger shrink inside its flex parent so the
            // title span's `truncate` actually engages — without it the
            // button falls back to min-content width and a long title
            // pushes the chevron out of the panel.
            className="min-w-0 flex-1 justify-start self-center"
            aria-label="Switch chat"
          >
            <IconMessageCircleFilled className="shrink-0 opacity-70" />
            <span className="min-w-0 flex-1 truncate text-left">
              {activeThread?.title || 'New chat'}
            </span>
            <IconChevronDown
              stroke={1.75}
              className={cn(
                'shrink-0 text-muted-foreground transition-transform',
                open && 'rotate-180',
              )}
            />
          </Button>
        </PopoverTrigger>

        <PopoverContent align="start" className="w-80 p-0">
          <Command>
            <CommandList>
              {active.length > 0 && (
                <CommandGroup>
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
                </CommandGroup>
              )}

              <CommandGroup>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <CommandItem
                      value="__new-chat"
                      onSelect={handleCreate}
                      disabled={atLimit}
                    >
                      <IconPlus className="shrink-0 opacity-70" />
                      <span className="flex-1">New chat</span>
                    </CommandItem>
                  </TooltipTrigger>
                  {atLimit && (
                    <TooltipContent side="bottom">
                      Up to {MAX_ACTIVE_THREADS} chats. Archive one to make room.
                    </TooltipContent>
                  )}
                </Tooltip>
              </CommandGroup>

              {archived.length > 0 && (
                <>
                  <CommandSeparator />
                  <CommandGroup heading="Archived">
                    {archived.map((t) => (
                      <CommandItem
                        key={t.id}
                        value={`archived:${t.id}`}
                        onSelect={() => handleRestore(t.id)}
                        disabled={atLimit}
                      >
                        <span className="min-w-0 flex-1 truncate text-foreground">
                          {t.title || 'New chat'}
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {formatRelative(t.archivedAt ?? t.updatedAt)}
                        </span>
                        <IconRestore
                          stroke={1.75}
                          className="shrink-0 text-muted-foreground"
                        />
                      </CommandItem>
                    ))}
                  </CommandGroup>
                  {atLimit && (
                    <div className="px-3 py-1.5 text-xs text-muted-foreground">
                      Already at {MAX_ACTIVE_THREADS} active chats. Archive one to restore.
                    </div>
                  )}
                </>
              )}
            </CommandList>
          </Command>
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
    <CommandItem
      value={meta.id}
      // While editing, disable cmdk on this row so its keyboard nav and
      // onSelect don't interfere with the inline input.
      disabled={editing}
      data-checked={isActive}
      onSelect={() => {
        if (editing) return
        onSelect()
      }}
      onDoubleClick={(e) => {
        e.stopPropagation()
        setEditing(true)
      }}
    >
      <IconMessageCircleFilled className="shrink-0 opacity-70" />

      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            // Stop cmdk from reading these as list navigation and stop
            // Radix Popover from dismissing on Escape.
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
          className="min-w-0 flex-1 rounded-md bg-transparent text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
        />
      ) : (
        <span className="min-w-0 flex-1 truncate">
          {meta.title || 'New chat'}
        </span>
      )}

      {/* Sibling button — real <button>, not a nested role="button". */}
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
        <IconX />
      </Button>
    </CommandItem>
  )
}
