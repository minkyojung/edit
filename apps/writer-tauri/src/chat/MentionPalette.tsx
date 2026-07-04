// Floating autocomplete that opens above the prompt textarea when the user
// types `@`. Mirrors SlashPalette: pure presentational — PromptInput owns the
// open/close state, the filtered+ranked list, and the selected index. Keyboard
// nav is intercepted in PromptInput so the textarea keeps focus and IME
// composition isn't disturbed.
//
// Two row kinds: agent ROLES (shown first — a colored circle + name + a
// truncated description preview; selecting one switches the chat's persona) and
// NOTES (title + vault path; selecting one attaches it as context).

import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'

/** A note the user can attach as context. */
export interface MentionItem {
  slug: string
  title: string
  /** Vault-relative path; what gets sent to the agent on submit. */
  path: string
}

/** A role the user can switch the chat to. */
export interface AgentMentionItem {
  /** Thread `agentId` — the role's file/frontmatter name. */
  agentId: string
  name: string
  description: string
}

/** A palette row: an agent role (first) or a note. */
export type MentionRow =
  | ({ kind: 'note' } & MentionItem)
  | ({ kind: 'agent' } & AgentMentionItem)

/** Stable key + React key for a row. */
export function rowKey(row: MentionRow): string {
  return row.kind === 'agent' ? `agent:${row.agentId}` : `note:${row.slug}`
}

/** Deterministic circle color for a role, so each role reads distinct at a
 * glance (matching the theme-picker feel). */
function hueFor(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) % 360
  return h
}

interface Props {
  items: MentionRow[]
  selectedIndex: number
  onSelect: (row: MentionRow) => void
  onHover: (index: number) => void
}

export function MentionPalette({ items, selectedIndex, onSelect, onHover }: Props) {
  const listRef = useRef<HTMLDivElement | null>(null)

  // Keep the highlighted row in view while the user arrows through.
  useEffect(() => {
    const item = listRef.current?.querySelector<HTMLElement>(
      `[data-mention-index="${selectedIndex}"]`,
    )
    item?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  if (items.length === 0) {
    return (
      <div
        className={cn(
          'absolute bottom-full left-0 right-0 mb-2 rounded-xl border border-border bg-popover',
          'p-3 text-body text-muted-foreground shadow-md',
        )}
      >
        No matches.
      </div>
    )
  }

  return (
    <div
      className={cn(
        'absolute bottom-full left-0 right-0 mb-2 rounded-xl border border-border bg-popover',
        'overflow-hidden shadow-md',
      )}
    >
      <div ref={listRef} className="max-h-64 overflow-y-auto p-1">
        {items.map((row, i) => {
          const selected = i === selectedIndex
          return (
            <button
              key={rowKey(row)}
              type="button"
              data-mention-index={i}
              onMouseDown={(e) => {
                // mousedown — not click — so the textarea doesn't lose focus
                // before we run the selection.
                e.preventDefault()
                onSelect(row)
              }}
              onMouseEnter={() => onHover(i)}
              className={cn(
                'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors',
                'outline-none focus-visible:ring-3 focus-visible:ring-ring/30',
                selected ? 'bg-muted' : 'hover:bg-muted/50',
              )}
            >
              {row.kind === 'agent' ? (
                <>
                  <span
                    className="h-4 w-4 shrink-0 rounded-full"
                    style={{ background: `hsl(${hueFor(row.agentId)} 55% 55%)` }}
                    aria-hidden
                  />
                  <span className="shrink-0 font-medium text-foreground">{row.name}</span>
                  {row.description && (
                    <span className="truncate text-footnote text-muted-foreground">
                      {row.description}
                    </span>
                  )}
                </>
              ) : (
                <>
                  <span className="shrink-0 truncate font-medium text-foreground">
                    {row.title}
                  </span>
                  <span className="truncate text-footnote text-muted-foreground">
                    {row.path}
                  </span>
                </>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
