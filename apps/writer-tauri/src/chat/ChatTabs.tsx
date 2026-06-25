// Segmented session switcher at the top of the chat panel — an
// NSSegmentedControl-style EQUAL-WIDTH bar. Every active thread is a
// segment; the focused one is a raised pill. All segments stay visible
// (no overflow/scroll), titles truncate with "…".
//
// The dot in the favicon slot is a KakaoTalk-style read/unread mark:
//   • solid (bg-foreground) → UNREAD: new turns arrived since you last
//                             opened this session
//   • faint               → read: you've looked since its last activity
// "Last activity" = the turn count (thread.updatedAt doesn't move on new
// messages); the focused thread is always read (RightPanel stamps it).
//
// Pure render of existing stores (threadsStore turns + seenThreadsStore)
// — no new backend. Replaces the ThreadPicker dropdown.

import { Fragment, useMemo } from 'react'
import { IconPlus, IconX } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useThreadsStore } from '@/state/threadsStore'
import { useSeenThreads } from '@/state/seenThreadsStore'
import { cn } from '@/lib/utils'
import { MAX_ACTIVE_THREADS, type ThreadMeta } from './types'

interface Props {
  active: ThreadMeta[]
  activeId: string | null
  onSelect: (id: string) => void
  onCreate: () => void
  onArchive: (id: string) => void
}

export function ChatTabs({
  active,
  activeId,
  onSelect,
  onCreate,
  onArchive,
}: Props) {
  const atLimit = active.length >= MAX_ACTIVE_THREADS
  // Stable position: creation order, not MRU, so segments don't reshuffle
  // as messages land.
  const ordered = useMemo(
    () => [...active].sort((a, b) => a.createdAt - b.createdAt),
    [active],
  )

  return (
    <TooltipProvider>
      <div className="flex min-w-0 flex-1 items-center gap-1">
        {/* Segmented track — equal-width segments fill it. */}
        <div className="flex h-9 min-w-0 flex-1 items-center rounded-full bg-muted p-[2.5px]">
          {ordered.map((t, i) => {
            const isActive = t.id === activeId
            // Hairline between two inactive segments; it vanishes next to
            // the raised active pill (the pill is the boundary).
            const prevActive = i > 0 && ordered[i - 1].id === activeId
            const showDivider = i > 0 && !isActive && !prevActive
            return (
              <Fragment key={t.id}>
                {showDivider && (
                  <span aria-hidden className="h-3 w-px shrink-0 bg-border/50" />
                )}
                <Segment
                  meta={t}
                  isActive={isActive}
                  onSelect={() => onSelect(t.id)}
                  onClose={() => onArchive(t.id)}
                />
              </Fragment>
            )
          })}
        </div>

        {/* New session. Disabled at the thread cap. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => {
                if (!atLimit) onCreate()
              }}
              disabled={atLimit}
              aria-label="New chat"
              className="shrink-0 text-sidebar-foreground/60 transition-colors hover:text-sidebar-foreground"
            >
              <IconPlus size={16} stroke={1.75} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {atLimit
              ? `Up to ${MAX_ACTIVE_THREADS} chats. Close one to make room.`
              : 'New chat'}
          </TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  )
}

interface SegmentProps {
  meta: ThreadMeta
  isActive: boolean
  onSelect: () => void
  onClose: () => void
}

function Segment({ meta, isActive, onSelect, onClose }: SegmentProps) {
  // Unread = new turns since last viewed. The active (focused) segment is
  // always read — RightPanel stamps its seen-count — and we guard on
  // isActive so it never flashes unread between a new turn and that stamp.
  const turnCount = useThreadsStore((s) => s.turns[meta.id]?.length ?? 0)
  const lastSeen = useSeenThreads((s) => s.lastSeenCount[meta.id] ?? 0)
  const unread = !isActive && turnCount > lastSeen

  return (
    <div
      data-state={isActive ? 'active' : 'inactive'}
      // The whole segment is the hit target (not just the title) — click or
      // Enter/Space anywhere selects. It can't be a <button> because it holds
      // the close <button>, so it's a role="tab" with keyboard handling.
      role="tab"
      aria-selected={isActive}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
      className={cn(
        // Equal width (flex-1). Transparent border reserves the active
        // pill's 1px border so widths/heights never jump on selection.
        'group relative flex h-full min-w-0 flex-1 cursor-pointer items-center justify-center gap-2.5 rounded-full border border-transparent px-2 text-[12px] outline-none transition-all',
        'text-muted-foreground hover:text-foreground',
        // Focus = a solid background swap (not a raised pill): the active
        // segment fills with the body colour, a clear step from the lighter
        // bg-muted track.
        'data-[state=active]:bg-background data-[state=active]:text-foreground',
      )}
    >
      <span
        aria-label={unread ? 'Unread' : undefined}
        className={cn(
          'size-1.5 shrink-0 rounded-full transition-colors',
          // Unread → solid; read/idle → faint.
          unread ? 'bg-foreground' : 'bg-muted-foreground/30',
        )}
      />

      <span className="min-w-0 truncate">{meta.title || 'New chat'}</span>

      {/* Close = archive. Active segment only; revealed on hover. Absolutely
          placed so it doesn't shift the centred title. stopPropagation so the
          segment's onClick (select) doesn't also fire. */}
      {isActive && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onClose()
          }}
          aria-label="Close chat"
          className="absolute right-1 flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition hover:bg-muted hover:text-foreground group-hover:opacity-100"
        >
          <IconX size={12} stroke={1.75} />
        </button>
      )}
    </div>
  )
}
