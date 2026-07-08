// Approval-mode picker for the PromptInput footer. Three mutually-exclusive
// ChatModes surfaced as a dropdown (Codex-style: icon + title + description +
// check on the active one). Each row maps 1:1 to a ChatMode and to a Claude
// Agent SDK `PermissionMode` (sdk.d.ts); the description states what the host
// actually does in our staged-review architecture, not the raw SDK wording:
//
//   edit        → SDK 'default'      — proposals wait for Keep/Reject
//   acceptEdits → SDK 'acceptEdits'  — proposals auto-apply the instant they land
//   plan        → SDK 'plan'         — read-only; explores + writes a plan, no edits
//
// Disabled while a turn streams (a switch wouldn't apply until the next send).

import {
  IconHandStop,
  IconWriting,
  IconMap,
  IconCheck,
  IconChevronDown,
  type IconProps,
} from '@tabler/icons-react'
import type { ComponentType } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { ChatMode } from '@/chat/types'
import { cn } from '@/lib/utils'

interface Props {
  value: ChatMode
  onChange: (next: ChatMode) => void
  disabled?: boolean
}

interface ModeOption {
  mode: ChatMode
  Icon: ComponentType<IconProps>
  title: string
  /** What the host actually does in this mode (not the raw SDK wording). */
  description: string
}

const MODES: readonly ModeOption[] = [
  {
    mode: 'edit',
    Icon: IconHandStop,
    title: 'Ask for approval',
    description: 'Review each edit before applying it',
  },
  {
    mode: 'acceptEdits',
    Icon: IconWriting,
    title: 'Auto-accept edits',
    description: 'Apply every edit automatically, no review',
  },
  {
    mode: 'plan',
    Icon: IconMap,
    title: 'Plan',
    description: 'Read-only — plan without making edits',
  },
]

export function ModeToggle({ value, onChange, disabled }: Props) {
  // Legacy threads may carry a mode no longer in MODES; fall back to the first.
  const active = MODES.find((m) => m.mode === value) ?? MODES[0]
  const TriggerIcon = active.Icon

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        aria-label={`Edit approval: ${active.title}`}
        className={cn(
          'inline-flex h-8 items-center gap-2 rounded-full px-2.5 text-muted-foreground transition-colors',
          'hover:bg-accent hover:text-foreground',
          'outline-none focus-visible:ring-3 focus-visible:ring-ring/30',
          'disabled:pointer-events-none disabled:opacity-50',
        )}
      >
        <TriggerIcon className="size-[18px] shrink-0" stroke={1.5} />
        {/* Selected label inherits the trigger's color (same as the icon).
            Container query: shown only when the footer is wide enough; the
            footer drops it to icon-only when space gets tight (no JS measure). */}
        <span className="hidden whitespace-nowrap text-body font-medium @[440px]/footer:inline">
          {active.title}
        </span>
        <IconChevronDown className="size-3.5 shrink-0 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-[420px] rounded-xl p-1">
        {MODES.map(({ mode, Icon, title, description }) => (
          <DropdownMenuItem
            key={mode}
            onSelect={() => onChange(mode)}
            className="items-center gap-2.5 rounded-lg px-2.5 py-1.5"
          >
            <Icon className="size-[18px] shrink-0 text-muted-foreground" stroke={1.5} />
            <div className="min-w-0 flex-1 leading-snug">
              <div className="text-body font-medium">{title}</div>
              <div className="whitespace-nowrap text-footnote font-normal text-muted-foreground">
                {description}
              </div>
            </div>
            {mode === active.mode && (
              <IconCheck className="size-4 shrink-0 text-muted-foreground" stroke={2} />
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
