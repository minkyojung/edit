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
      className="flex shrink-0 items-center gap-1 bg-transparent px-2 shadow-[inset_0_-1px_0_var(--border)]"
      style={{ height: 'var(--header-h)' }}
    >
      {/* Tinted capsule filters — the macOS Tahoe pattern Apple Mail
          uses for its category bar. Each item is its own capsule;
          only the active one expands to show its label and takes on
          its tint color. Inactive items collapse to an icon-only
          muted pill, so the active selection always reads as the
          strongest visual element. */}
      <div className="inline-flex items-center gap-1.5">
        <CapsuleFilterItem
          active={mode === 'chat'}
          onClick={() => setMode('chat')}
          icon={<IconMessageCircle size={16} />}
          label="Chat"
          activeBg="bg-info/20"
          activeText="text-foreground"
          dotColor="bg-info"
        />
        <CapsuleFilterItem
          active={mode === 'review'}
          onClick={() => setMode('review')}
          icon={<IconHistory size={16} />}
          label="Review"
          activeBg="bg-success/20"
          activeText="text-foreground"
          dotColor="bg-success"
          badge={activityCount > 0 ? activityCount : undefined}
          warning={gitStatus === 'error'}
        />
      </div>
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
      variant="ghost"
      size="sm"
      disabled={disabled}
      onClick={() => {
        void commitImmediate()
      }}
      className="ml-auto h-8 cursor-pointer gap-1.5 px-2.5 text-sm hover:bg-foreground/10 dark:hover:bg-foreground/10"
      aria-label={
        dirtyCount === 0
          ? 'No unsaved changes'
          : `Save snapshot (${dirtyCount} file${dirtyCount === 1 ? '' : 's'})`
      }
    >
      <IconCameraPlus size={16} />
      <span>Save snapshot</span>
    </Button>
  )
}

// Tahoe spring easing — Apple's standard motion curve for material
// transitions. Used inline here; if we end up applying it to more
// components we can lift it to a CSS variable.
const TAHOE_EASE = 'cubic-bezier(0.32, 0.72, 0, 1)'

function CapsuleFilterItem({
  active,
  onClick,
  icon,
  label,
  badge,
  warning,
  activeBg,
  activeText,
  dotColor,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
  badge?: number
  warning?: boolean
  /** Tailwind class for the active state background tint (e.g. "bg-info/20"). */
  activeBg: string
  /** Tailwind class for the active state foreground (e.g. "text-foreground"). */
  activeText: string
  /** Vivid tint used for the corner attention dot when inactive
   * (e.g. "bg-info"). Separate from activeBg because that one is
   * usually a low-alpha tint that would read as nothing on the dot. */
  dotColor: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{ transitionTimingFunction: TAHOE_EASE }}
      className={cn(
        'relative inline-flex h-8 cursor-pointer items-center rounded-full text-sm font-medium outline-none',
        'transition-[background-color,color,padding] duration-300',
        active
          ? cn('gap-1.5 px-3', activeBg, activeText)
          : 'px-2 bg-foreground/8 text-muted-foreground hover:text-foreground hover:bg-foreground/15',
        warning && !active && 'text-destructive',
      )}
    >
      {icon}
      {/* Label is always mounted so screen readers see it; visual
          width + opacity morph on the active flip. max-width drives
          the capsule's expand/contract, opacity hides leftover text
          mid-animation. */}
      <span
        style={{ transitionTimingFunction: TAHOE_EASE }}
        className={cn(
          'overflow-hidden whitespace-nowrap transition-[max-width,opacity,margin] duration-300',
          active ? 'ml-1 max-w-32 opacity-100' : 'ml-0 max-w-0 opacity-0',
        )}
      >
        {label}
      </span>
      {/* Badge: active gets the full number pill inline with the label;
          inactive gets a small attention dot pinned to the corner so
          the unreviewed count is still discoverable while collapsed. */}
      {badge !== undefined &&
        (active ? (
          <span
            className="ml-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-foreground/15 px-1 text-[10px] font-medium leading-none"
            aria-hidden
          >
            {badge > 99 ? '99+' : badge}
          </span>
        ) : (
          <span
            className={cn(
              'absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full',
              warning ? 'bg-destructive' : dotColor,
            )}
            aria-hidden
          />
        ))}
    </button>
  )
}
