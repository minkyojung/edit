// Wrapper for the right-hand column. Shows a small mode toggle
// at the top — Chat / Review — and swaps the body component
// accordingly. The toggle owns the entry point for both surfaces;
// the editor header no longer carries a git status badge because
// the Review tab IS the badge (it shows the unreviewed count
// inline).
//
// The wrapper itself doesn't manage open/closed state — that's
// `contextPanelOpen` in layoutStore, controlled by the ResizablePanel
// in AppShell. When the panel is collapsed this component still
// mounts (Resizable just hides it visually) so opening the panel
// shows the last-active mode without a re-mount flicker.

import { IconCameraPlus, IconHistory, IconMessageCircle } from '@tabler/icons-react'
import type { EditorView } from '@milkdown/kit/prose/view'
import type * as Y from 'yjs'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useLayoutStore } from '@/state/layoutStore'
import { useGitStore } from '@/state/gitStore'
import { ChatPanel } from './ChatPanel'
import { ReviewPanel } from './ReviewPanel'

interface Props {
  editorView: EditorView | null
  ydoc: Y.Doc | null
  slug: string | null
}

export function RightPanel({ editorView, ydoc, slug }: Props) {
  const mode = useLayoutStore((s) => s.rightPanelMode)
  return (
    <div className="flex h-full flex-col">
      <RightPanelHeader />
      <div className="min-h-0 flex-1">
        {mode === 'chat' ? (
          <ChatPanel editorView={editorView} ydoc={ydoc} slug={slug} />
        ) : (
          <ReviewPanel />
        )}
      </div>
    </div>
  )
}

function RightPanelHeader() {
  const mode = useLayoutStore((s) => s.rightPanelMode)
  const setMode = useLayoutStore((s) => s.setRightPanelMode)
  const activityCount = useGitStore((s) => s.activity.length)
  const gitStatus = useGitStore((s) => s.status)

  return (
    <div
      className="flex shrink-0 items-center gap-1 border-b border-border px-2"
      style={{ height: 'var(--header-h)' }}
    >
      <TabButton
        active={mode === 'chat'}
        onClick={() => setMode('chat')}
        icon={<IconMessageCircle size={14} />}
        label="Chat"
      />
      <TabButton
        active={mode === 'review'}
        onClick={() => setMode('review')}
        icon={<IconHistory size={14} />}
        label="Review"
        badge={activityCount > 0 ? activityCount : undefined}
        warning={gitStatus === 'error'}
      />
      <SaveSnapshotButton />
    </div>
  )
}

function SaveSnapshotButton() {
  const dirtyCount = useGitStore((s) => s.dirtyPaths.size)
  const gitStatus = useGitStore((s) => s.status)
  const commitImmediate = useGitStore((s) => s.commitImmediate)
  const disabled = dirtyCount === 0 || gitStatus === 'committing'
  return (
    <Button
      variant="default"
      size="sm"
      disabled={disabled}
      onClick={() => {
        void commitImmediate()
      }}
      className="ml-auto h-7 cursor-pointer gap-1 px-2.5 text-xs"
      aria-label={
        dirtyCount === 0
          ? 'No unsaved changes'
          : `Save snapshot (${dirtyCount} file${dirtyCount === 1 ? '' : 's'})`
      }
    >
      <IconCameraPlus size={14} />
      <span>Save snapshot</span>
    </Button>
  )
}

function TabButton({
  active,
  onClick,
  icon,
  label,
  badge,
  warning,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
  badge?: number
  warning?: boolean
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={onClick}
      className={cn(
        'relative h-7 cursor-pointer gap-1 px-2 text-xs',
        active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
        warning && 'text-destructive',
      )}
      aria-pressed={active}
    >
      {icon}
      <span>{label}</span>
      {badge !== undefined && (
        <span
          className="ml-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium leading-none text-primary-foreground"
          aria-hidden
        >
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </Button>
  )
}
