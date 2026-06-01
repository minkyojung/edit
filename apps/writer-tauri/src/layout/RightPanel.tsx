// Wrapper for the right-hand column. A single top bar carries the
// thread picker on the left and a History toggle on the right; the
// body below swaps between the chat transcript and the history view
// (git activity + undo). The History button doubles as the
// unreviewed-changes badge — its dot shows the new-activity count —
// so the editor header doesn't need its own git status badge.
//
// The wrapper itself doesn't manage open/closed state — that's
// `contextPanelOpen` in layoutStore, controlled by the ResizablePanel
// in AppShell. When the panel is collapsed this component still
// mounts (Resizable just hides it visually) so opening the panel
// shows the last-active mode without a re-mount flicker.

import { IconHistory } from '@tabler/icons-react'
import type { EditorView } from '@milkdown/kit/prose/view'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useLayoutStore } from '@/state/layoutStore'
import { useGitStore } from '@/state/gitStore'
import { useThreads, type UseThreadsResult } from '@/hooks/useThreads'
import { useActiveThread } from '@/hooks/useActiveThread'
import { ThreadPicker } from '@/chat/ThreadPicker'
import { notify } from '@/lib/notify'
import { ChatPanel } from './ChatPanel'
import { ReviewPanel } from './ReviewPanel'

interface Props {
  editorView: EditorView | null
  slug: string | null
}

export function RightPanel({ editorView, slug }: Props) {
  const mode = useLayoutStore((s) => s.rightPanelMode)
  // Threads are owned here, not in ChatPanel, so the picker can live in
  // the shared top bar that sits above BOTH the chat transcript and the
  // history view. useActiveThread holds a single useState — calling it
  // in two places would fork the active id — so it stays at this one
  // mount point and the id flows down to ChatPanel as a prop.
  const threads = useThreads(slug)
  const { activeId, setActiveId } = useActiveThread(threads.active)
  return (
    <div className="relative flex h-full flex-col">
      <div className="min-h-0 flex-1">
        {mode === 'chat' ? (
          <ChatPanel
            editorView={editorView}
            slug={slug}
            threads={threads}
            activeId={activeId}
          />
        ) : (
          <ReviewPanel />
        )}
      </div>
      {/* Glass fade band: content dissolves UNDER the header instead of being
          cut by a divider — the same treatment as the editor header and the
          chat composer. The header chrome paints on top (z-sticky). */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 z-sticky bg-sidebar/90"
        style={{
          height: 'calc(var(--header-h) + 2rem)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          maskImage:
            'linear-gradient(to bottom, black, black calc(var(--header-h) * 0.7), transparent)',
          WebkitMaskImage:
            'linear-gradient(to bottom, black, black calc(var(--header-h) * 0.7), transparent)',
        }}
      />
      {/* Same header rule as the editor / left-sidebar headers
          (height: var(--header-h) + items-center). The right panel is a
          floating card inset 8px MORE than the editor area (its own py-2 on top
          of SidebarInset's my-2), so -translate-y-2 cancels that extra 8px to
          put these buttons on the exact same baseline as the editor header. */}
      <div className="absolute inset-x-0 top-0 z-sticky -translate-y-2">
        <RightPanelHeader
          threads={threads}
          activeId={activeId}
          setActiveId={setActiveId}
        />
      </div>
    </div>
  )
}

function RightPanelHeader({
  threads,
  activeId,
  setActiveId,
}: {
  threads: UseThreadsResult
  activeId: string | null
  setActiveId: (id: string | null) => void
}) {
  const mode = useLayoutStore((s) => s.rightPanelMode)
  const setMode = useLayoutStore((s) => s.setRightPanelMode)
  const activityCount = useGitStore((s) => s.activity.length)
  const gitStatus = useGitStore((s) => s.status)
  const showActivityDot =
    mode !== 'review' && (activityCount > 0 || gitStatus === 'error')
  const historyTooltip =
    gitStatus === 'error'
      ? 'History (storage error)'
      : activityCount > 0
        ? `History (${activityCount} new)`
        : 'History'

  return (
    <div
      className="flex items-center gap-0.5 bg-transparent px-0.5"
      style={{ height: 'var(--header-h)' }}
    >
      <ThreadPicker
        active={threads.active}
        archived={threads.archived}
        activeId={activeId}
        onSelect={(id) => {
          setActiveId(id)
          // Picking a thread means "take me to that conversation" — snap
          // back to chat if the history view happens to be showing.
          setMode('chat')
        }}
        onCreate={async () => {
          const id = await threads.createThread()
          if (id) setActiveId(id)
          setMode('chat')
        }}
        onArchive={(id) => {
          threads.archiveThread(id)
          // Active thread reconciles in useActiveThread when active list shifts.
        }}
        onRename={threads.renameThread}
        onRestore={(id) => {
          const r = threads.restoreThread(id)
          if (r.ok) setActiveId(id)
          return r
        }}
        onRestoreLimitReached={() => {
          notify.threadLimitReached()
        }}
      />
      <ModeToggleButton
        active={mode === 'review'}
        onClick={() => setMode(mode === 'review' ? 'chat' : 'review')}
        icon={<IconHistory size={16} />}
        tooltip={historyTooltip}
        ariaLabel="History"
        dot={
          showActivityDot
            ? gitStatus === 'error'
              ? 'destructive'
              : 'primary'
            : undefined
        }
      />
    </div>
  )
}

function ModeToggleButton({
  active,
  onClick,
  icon,
  tooltip,
  ariaLabel,
  dot,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  tooltip: string
  ariaLabel: string
  dot?: 'primary' | 'destructive'
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClick}
          aria-pressed={active}
          aria-label={ariaLabel}
          className={cn(
            'relative cursor-pointer transition-colors',
            active
              ? 'bg-accent text-foreground hover:bg-accent'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {icon}
          {dot && (
            <span
              className={cn(
                'absolute right-1 top-1 h-1.5 w-1.5 rounded-full',
                dot === 'destructive' ? 'bg-destructive' : 'bg-primary',
              )}
              aria-hidden
            />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{tooltip}</TooltipContent>
    </Tooltip>
  )
}
