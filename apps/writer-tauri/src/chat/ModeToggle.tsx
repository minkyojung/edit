// Approval-mode picker for the PromptInput footer. Three mutually-exclusive
// ChatModes surfaced as a dropdown (Codex-style: icon + title + description +
// check on the active one). The rows themselves live in chat/modes.ts, shared
// with the composer's Shift+Tab shortcut so the two cycle in the same order.
//
// Disabled while a turn streams (a switch wouldn't apply until the next send).

import { IconCheck, IconChevronDown } from '@tabler/icons-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { CHAT_MODES, chatModeOption } from '@/chat/modes'
import type { ChatMode } from '@/chat/types'
import { cn } from '@/lib/utils'

interface Props {
  value: ChatMode
  onChange: (next: ChatMode) => void
  disabled?: boolean
}

export function ModeToggle({ value, onChange, disabled }: Props) {
  const active = chatModeOption(value)
  const TriggerIcon = active.Icon

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        aria-label={`Edit approval: ${active.title}`}
        aria-keyshortcuts="Shift+Tab"
        className={cn(
          'inline-flex h-8 items-center gap-2 rounded-full px-2.5 text-muted-foreground transition-colors',
          'hover:bg-accent hover:text-foreground',
          'outline-none focus-visible:ring-3 focus-visible:ring-ring/30',
          'disabled:pointer-events-none disabled:opacity-50',
        )}
      >
        {/* Keyed on the mode so React remounts this span on every change and the
            enter animation replays — `animate-in` only fires on mount. The key
            stays OFF the trigger itself: Radix anchors the menu and restores
            focus through the trigger's ref, and remounting it breaks both.
            The chevron sits outside for the same reason it doesn't change: only
            what the switch actually swaps should move.
            duration/ease are the app's state-change motion (--motion-state:
            200ms ease-tahoe), not tw-animate-css's 150ms/ease default — these
            utilities feed --tw-duration/--tw-ease, which `animate-in` reads. */}
        <span
          key={active.mode}
          className="inline-flex items-center gap-2 duration-200 ease-tahoe animate-in fade-in-0 zoom-in-95 motion-reduce:animate-none"
        >
          <TriggerIcon className="size-[18px] shrink-0" stroke={1.5} />
          {/* Selected label inherits the trigger's color (same as the icon).
              Container query: shown only when the footer is wide enough; the
              footer drops it to icon-only when space gets tight (no JS measure). */}
          <span className="hidden whitespace-nowrap text-body font-medium @[440px]/footer:inline">
            {active.title}
          </span>
        </span>
        <IconChevronDown className="size-3.5 shrink-0 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-[420px] rounded-xl p-1">
        {CHAT_MODES.map(({ mode, Icon, title, description }) => (
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
