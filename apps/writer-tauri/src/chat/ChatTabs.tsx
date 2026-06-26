// Session switcher at the top of the chat panel — a flat, left-aligned
// editor-style tab strip (VSCode/Cursor tabs), NOT an enclosed segmented
// control. Tabs size to their title and shrink + truncate when crowded;
// the focused one gets a soft `bg-muted` highlight. Hairlines separate
// adjacent inactive tabs.
//
// The dot in the leading slot is a KakaoTalk-style read/unread mark:
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
        {/* Flat tab strip — tabs sit on the header, sized to content and
            left-aligned; min-w-0 lets them shrink + truncate when crowded. */}
        <div className="flex h-9 min-w-0 items-center">
          {ordered.map((t, i) => {
            const isActive = t.id === activeId
            // Hairline between two inactive tabs; it goes transparent next to
            // the active tab. The span ALWAYS occupies 1px (only its colour
            // toggles) so selecting a tab never shifts the strip.
            const prevActive = i > 0 && ordered[i - 1].id === activeId
            const dividerVisible = !isActive && !prevActive
            return (
              <Fragment key={t.id}>
                {i > 0 && (
                  <span
                    aria-hidden
                    className={cn(
                      'h-3 w-px shrink-0',
                      dividerVisible ? 'bg-border/50' : 'bg-transparent',
                    )}
                  />
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
              variant="iconGhost"
              size="icon-sm"
              onClick={() => {
                if (!atLimit) onCreate()
              }}
              disabled={atLimit}
              aria-label="New chat"
              className="shrink-0"
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
        // Content-width, left-aligned tab; min-w-0 lets the title truncate
        // when the strip is crowded instead of overflowing. Padding is
        // identical in every state so selecting a tab never resizes it.
        'group relative flex h-full min-w-0 cursor-pointer items-center justify-start gap-2 rounded-md px-4 text-footnote outline-none transition-colors',
        // Hovering any tab fills it with the same muted surface the active
        // tab uses — so the close badge's fade gradient (from-muted) always
        // has a matching backdrop, on selected and unselected tabs alike.
        'text-muted-foreground hover:bg-muted hover:text-foreground',
        // Focus = a soft muted fill on the bare header + a brighter glyph.
        'data-[state=active]:bg-muted data-[state=active]:text-foreground',
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
      {/* Close badge shows on hover of ANY tab (not just the selected one).
          Fade the title out under it instead of letting them collide — the
          gradient matches the tab's hover/active bg-muted fill. Painted after
          the title (covers it) but before the button (which stays on top). */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 right-0 w-14 rounded-r-md bg-gradient-to-l from-muted from-50% to-transparent opacity-0 transition-opacity group-hover:opacity-100"
      />
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
        aria-label="Close chat"
        className="absolute right-1.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-muted-foreground/40 text-foreground opacity-0 transition hover:bg-muted-foreground/60 group-hover:opacity-100 dark:bg-foreground dark:text-background dark:hover:bg-foreground/90"
      >
        <IconX size={9} stroke={2.5} />
      </button>
    </div>
  )
}
