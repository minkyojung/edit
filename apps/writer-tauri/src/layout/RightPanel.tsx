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

import { IconHistory, IconMessageCircle } from '@tabler/icons-react'
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
import { ChatPanel } from './ChatPanel'
import { ReviewPanel } from './ReviewPanel'

interface Props {
  editorView: EditorView | null
  slug: string | null
}

export function RightPanel({ editorView, slug }: Props) {
  const mode = useLayoutStore((s) => s.rightPanelMode)
  return (
    <div className="flex h-full flex-col">
      <RightPanelHeader />
      <div className="min-h-0 flex-1">
        {mode === 'chat' ? (
          <ChatPanel editorView={editorView} slug={slug} />
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
  const showActivityDot =
    mode !== 'review' && (activityCount > 0 || gitStatus === 'error')
  const reviewTooltip =
    gitStatus === 'error'
      ? 'Review (storage error)'
      : activityCount > 0
        ? `Review (${activityCount} new)`
        : 'Review'

  return (
    <div
      className="flex shrink-0 items-center gap-0.5 px-1 shadow-[inset_0_-1px_0_var(--border)]"
      style={{ height: '36px' }}
    >
      <ModeToggleButton
        active={mode === 'chat'}
        onClick={() => setMode('chat')}
        icon={<IconMessageCircle size={16} />}
        tooltip="Chat"
        ariaLabel="Chat"
      />
      <ModeToggleButton
        active={mode === 'review'}
        onClick={() => setMode('review')}
        icon={<IconHistory size={16} />}
        tooltip={reviewTooltip}
        ariaLabel="Review"
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
