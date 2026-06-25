// Segmented session switcher at the top of the chat panel — an
// NSSegmentedControl-style EQUAL-WIDTH bar. Every active thread is a
// segment; the focused one is a raised pill. All segments stay visible
// (no overflow/scroll), titles truncate with "…".
//
// Status comes FIRST. A glyph in the favicon slot encodes each session's
// state so a glance reads the whole fleet without reading titles:
//   • running        → the app's dot-matrix loader, calm --success tint
//   • waiting for you → a LOUD pulsing --warning dot (the bottleneck:
//                       the agent is parked on a permission / question)
//   • idle / done     → a faint neutral dot
// Title is the secondary label — it can truncate freely.
//
// Pure render of existing stores (threadsStore via props, chatRuns,
// pendingPermissions) — no new backend. Replaces the ThreadPicker dropdown.

import { Fragment, useMemo } from 'react'
import { IconPlus, IconX } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { ChatRunningIcon } from '@/components/icons/ChatRunningIcon'
import { useChatRuns } from '@/stores/chatRuns'
import { usePendingPermissions } from '@/state/pendingPermissionsStore'
import { cn } from '@/lib/utils'
import { MAX_ACTIVE_THREADS, type ThreadMeta } from './types'

type ThreadStatus = 'waiting' | 'running' | 'idle'

/** Per-thread live status. Waiting (a parked permission / question) wins
 * over running — it's the state that needs the human. */
function useThreadStatus(threadId: string): ThreadStatus {
  const waiting = usePendingPermissions((s) =>
    Object.values(s.byRun).some((p) => p.threadId === threadId),
  )
  const running = useChatRuns((s) => {
    for (const r of s.runs.values()) if (r.threadId === threadId) return true
    return false
  })
  return waiting ? 'waiting' : running ? 'running' : 'idle'
}

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

function StatusGlyph({ status }: { status: ThreadStatus }) {
  if (status === 'running')
    return (
      <ChatRunningIcon
        size={13}
        className="shrink-0 text-[var(--success)]"
      />
    )
  if (status === 'waiting')
    return (
      <span
        // Loud: the agent is waiting on you. Pulse pulls the eye.
        className="size-2 shrink-0 animate-pulse rounded-full bg-[var(--warning)]"
        aria-label="Waiting for you"
      />
    )
  return (
    <span
      aria-hidden
      className="size-1.5 shrink-0 rounded-full bg-muted-foreground/40"
    />
  )
}

interface SegmentProps {
  meta: ThreadMeta
  isActive: boolean
  onSelect: () => void
  onClose: () => void
}

function Segment({ meta, isActive, onSelect, onClose }: SegmentProps) {
  const status = useThreadStatus(meta.id)

  return (
    <div
      data-state={isActive ? 'active' : 'inactive'}
      className={cn(
        // Equal width (flex-1). Transparent border reserves the active
        // pill's 1px border so widths/heights never jump on selection.
        'group relative flex h-full min-w-0 flex-1 items-center justify-center gap-2.5 rounded-full border border-transparent px-2 text-[12px] transition-all',
        'text-muted-foreground hover:text-foreground',
        // Focus = a solid background swap (not a raised pill): the active
        // segment fills with the body colour, a clear step from the lighter
        // bg-muted track.
        'data-[state=active]:bg-background data-[state=active]:text-foreground',
        // Waiting tints the whole segment so it reads even unfocused.
        status === 'waiting' && 'text-[var(--warning)]',
      )}
    >
      <StatusGlyph status={status} />

      <button
        type="button"
        onClick={onSelect}
        aria-current={isActive ? 'page' : undefined}
        className="min-w-0 truncate text-left outline-none"
      >
        {meta.title || 'New chat'}
      </button>

      {/* Close = archive. Active segment only; revealed on hover. Absolutely
          placed so it doesn't shift the centred title. */}
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
