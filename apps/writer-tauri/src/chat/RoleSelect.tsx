// Role/persona picker for the PromptInput footer. Mirrors ModeToggle (a
// dropdown of icon/title/description rows with a check on the active one), but
// the options are the user's agent roles (`_system/agent/agents/*.md`, loaded
// at mount) rendered with a colored circle each. Selecting one switches the
// whole thread's persona (agentId) — a thread-level setting like the model /
// mode, which is why it lives here as a control rather than an @-mention typed
// into the message.
//
// Disabled while a turn streams (a switch wouldn't apply until the next send).

import { useEffect, useState } from 'react'
import { IconCheck, IconChevronDown } from '@tabler/icons-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { listAgents, type VaultAgent } from '@/lib/agentsLib'
import { cn } from '@/lib/utils'

/** Deterministic circle color per role, so each reads distinct at a glance. */
function hueFor(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) % 360
  return h
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

interface Props {
  /** Current thread role (agentId). Undefined / 'default' = the base persona. */
  value?: string
  onChange: (agentId: string) => void
  disabled?: boolean
}

export function RoleSelect({ value, onChange, disabled }: Props) {
  const [roles, setRoles] = useState<VaultAgent[]>([])
  useEffect(() => {
    listAgents()
      .then(setRoles)
      .catch(() => setRoles([]))
  }, [])

  const activeId = value?.trim() || 'default'
  const active = roles.find((r) => r.name === activeId)
  const activeName = active ? cap(active.name) : 'Default'

  // Nothing to switch between until roles load (and the vault has at least the
  // seeded default). Hidden rather than showing an empty control.
  if (roles.length === 0) return null

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        aria-label={`Role: ${activeName}`}
        className={cn(
          'inline-flex h-8 items-center gap-2 rounded-full px-2.5 text-muted-foreground transition-colors',
          'hover:bg-accent hover:text-foreground',
          'outline-none focus-visible:ring-3 focus-visible:ring-ring/30',
          'disabled:pointer-events-none disabled:opacity-50',
        )}
      >
        <span
          className="size-[14px] shrink-0 rounded-full"
          style={{ background: `hsl(${hueFor(activeId)} 55% 55%)` }}
          aria-hidden
        />
        <span className="hidden whitespace-nowrap text-body font-medium @[440px]/footer:inline">
          {activeName}
        </span>
        <IconChevronDown className="size-3.5 shrink-0 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-[320px] rounded-xl p-1">
        {roles.map((r) => (
          <DropdownMenuItem
            key={r.fileName}
            onSelect={() => onChange(r.name)}
            className="items-center gap-2.5 rounded-lg px-2.5 py-1.5"
          >
            <span
              className="size-[14px] shrink-0 rounded-full"
              style={{ background: `hsl(${hueFor(r.name)} 55% 55%)` }}
              aria-hidden
            />
            <div className="min-w-0 flex-1 leading-snug">
              <div className="text-body font-medium">{cap(r.name)}</div>
              {r.description && (
                <div className="truncate text-footnote font-normal text-muted-foreground">
                  {r.description}
                </div>
              )}
            </div>
            {r.name === activeId && (
              <IconCheck className="size-4 shrink-0 text-muted-foreground" stroke={2} />
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
