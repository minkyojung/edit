// Wrapper for the right-hand column. A single top bar carries the
// thread picker on the left and a History toggle on the right; the
// body below swaps between the chat transcript and the history view
// (git activity + undo). The History button doubles as the
// unreviewed-changes badge — its dot shows the new-activity count —
// so the editor header doesn't need its own git status badge.
//
// The wrapper itself doesn't manage open/closed state — that's
// `contextPanelOpen` in layoutStore. AppShell drives the inspector
// column's width from it (a CSS-flex layout, not react-resizable-panels).
// When closed the column is width 0 but this component stays mounted, so
// reopening shows the last-active mode without a re-mount flicker.

import type { EditorView } from '@milkdown/kit/prose/view'
import { useLayoutStore } from '@/state/layoutStore'
import { useThreads, type UseThreadsResult } from '@/hooks/useThreads'
import { useActiveThread } from '@/hooks/useActiveThread'
import { ThreadPicker } from '@/chat/ThreadPicker'
import { notify } from '@/lib/notify'
import { ChatPanel } from './ChatPanel'

interface Props {
  editorView: EditorView | null
  slug: string | null
}

export function RightPanel({ editorView, slug }: Props) {
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
        {/* Review/history panel removed — versioning/backup is being redesigned
            as an opt-in layer. The right panel is chat-only for now. */}
        <ChatPanel
          editorView={editorView}
          slug={slug}
          threads={threads}
          activeId={activeId}
        />
      </div>
      {/* Glass fade band: content dissolves UNDER the header instead of being
          cut by a divider — the same treatment as the editor header and the
          chat composer. The header chrome paints on top (z-sticky). */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 z-sticky bg-background/90"
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
      {/* The panel is flush with the window top (no inset), so a full
          var(--header-h) bar lands on the editor header's exact baseline. */}
      <div className="absolute inset-x-0 top-0 z-sticky">
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
  const setMode = useLayoutStore((s) => s.setRightPanelMode)

  return (
    <div
      className="flex items-center gap-0.5 bg-transparent px-1.5"
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
    </div>
  )
}

