// Horizontal tab strip at the top of the chat panel.
//
// Built on Radix's Tabs primitive (TabsPrimitive.Root) so we get the full
// tablist semantics, ←/→/Home/End keyboard nav, and proper focus
// management for free. The visual is bespoke — Radix is unstyled, we
// supply the slim flat-strip look ourselves. We deliberately do NOT
// render TabsPrimitive.Content here: the chat panel below is the
// de-facto tabpanel, but it's a single shared scroll area swapped by
// activeId rather than N siblings, so wiring full aria-controls would
// add DOM gymnastics for no real screen-reader gain.
//
// - At most 5 active threads. The [+] button is disabled past that with
//   a tooltip nudging the user to archive one first.
// - Each tab has an [×] button that soft-archives the thread. Visible
//   at low opacity by default so touch users can find it without hover.
// - Double-clicking a tab title swaps it for an inline editor.
// - The clock button on the far right opens the archive popover.

import { useEffect, useRef, useState } from 'react'
import { IconSparkles, IconPlus, IconX } from '@tabler/icons-react'
import { Tabs as TabsPrimitive } from 'radix-ui'
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
  const rootRef = useRef<HTMLDivElement>(null)

  // Tab-switch shortcuts: ⌘⇧[ previous, ⌘⇧] next (Ctrl on non-Mac).
  // Cursor-style focus scoping — the same chord swaps editor docs
  // when focus is in the editor, so we only fire when something
  // inside the chat panel currently has focus. The chat panel
  // marks itself with data-chat-panel; we walk up from the tablist
  // to find that boundary and gate on it.
  useEffect(() => {
    if (active.length <= 1) return
    const handler = (e: KeyboardEvent) => {
      if (!e.shiftKey || !(e.metaKey || e.ctrlKey)) return
      const isPrev = e.key === '[' || e.code === 'BracketLeft'
      const isNext = e.key === ']' || e.code === 'BracketRight'
      if (!isPrev && !isNext) return
      const chatPanel = rootRef.current?.closest('[data-chat-panel]')
      if (!chatPanel || !chatPanel.contains(document.activeElement)) return
      e.preventDefault()
      const idx = active.findIndex((t) => t.id === activeId)
      const cur = idx < 0 ? 0 : idx
      const next = isPrev
        ? (cur - 1 + active.length) % active.length
        : (cur + 1) % active.length
      onSelect(active[next].id)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [active, activeId, onSelect])

  return (
    <TooltipProvider>
      <TabsPrimitive.Root
        ref={rootRef}
        value={activeId ?? ''}
        onValueChange={onSelect}
        className="flex flex-1 items-stretch gap-1 overflow-hidden"
      >
        <TabsPrimitive.List
          aria-label="Chat threads"
          className="flex flex-1 items-stretch gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {active.map((t) => (
            <Tab
              key={t.id}
              meta={t}
              isActive={t.id === activeId}
              onArchive={() => onArchive(t.id)}
              onRename={(title) => onRename(t.id, title)}
            />
          ))}

          {/* [+] new thread — sits inside the list visually but isn't a
              tablist member, so render outside any TabsTrigger. */}
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
                  'flex size-7 shrink-0 items-center justify-center self-center rounded-md text-muted-foreground transition-colors',
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
        </TabsPrimitive.List>

        <ArchivedThreadsPopover
          archived={archived}
          activeCount={active.length}
          onRestore={onRestore}
          onLimitReached={onRestoreLimitReached}
        />
      </TabsPrimitive.Root>
    </TooltipProvider>
  )
}

interface TabProps {
  meta: ThreadMeta
  isActive: boolean
  onArchive: () => void
  onRename: (title: string) => void
}

function Tab({ meta, isActive, onArchive, onRename }: TabProps) {
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
    <TabsPrimitive.Trigger
      value={meta.id}
      onDoubleClick={() => setEditing(true)}
      className={cn(
        'group flex max-w-[180px] shrink-0 items-center gap-1.5 px-1.5 text-sm font-medium transition-colors',
        'border-b',
        'outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
        isActive
          ? 'border-foreground text-foreground'
          : 'border-transparent text-muted-foreground hover:text-foreground',
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
            // Prevent Radix's tablist arrow-key navigation from stealing
            // input keystrokes while we're renaming.
            e.stopPropagation()
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
          'flex h-4 w-4 shrink-0 items-center justify-center rounded transition-opacity hover:bg-foreground/10',
          'outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
          'opacity-0 group-hover:opacity-60 group-focus-visible:opacity-60 hover:!opacity-100',
          isActive && 'opacity-60',
        )}
      >
        <IconX size={12} stroke={2} />
      </span>
    </TabsPrimitive.Trigger>
  )
}
