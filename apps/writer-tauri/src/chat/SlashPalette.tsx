// Floating autocomplete that opens above the prompt textarea when the
// user types `/`. Pure presentational — PromptInput owns the open/close
// state, the filtered command list, and the selected index. Keyboard
// navigation (ArrowUp / ArrowDown / Enter / Esc / Tab) is intercepted
// in PromptInput so the textarea keeps focus and IME composition isn't
// disturbed.

import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import type { LoadedCommand } from '@/chat/commands'

interface Props {
  commands: LoadedCommand[]
  selectedIndex: number
  onSelect: (cmd: LoadedCommand) => void
  onHover: (index: number) => void
}

export function SlashPalette({ commands, selectedIndex, onSelect, onHover }: Props) {
  const listRef = useRef<HTMLDivElement | null>(null)

  // Keep the highlighted row in view while the user arrows through.
  useEffect(() => {
    const item = listRef.current?.querySelector<HTMLElement>(
      `[data-slash-index="${selectedIndex}"]`,
    )
    item?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  if (commands.length === 0) {
    return (
      <div
        className={cn(
          'absolute bottom-full left-0 right-0 mb-2 rounded-xl border border-border bg-popover',
          'p-3 text-body text-muted-foreground shadow-md',
        )}
      >
        No matching commands.
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
        {commands.map((cmd, i) => {
          const selected = i === selectedIndex
          return (
            <button
              key={cmd.name}
              type="button"
              data-slash-index={i}
              onMouseDown={(e) => {
                // mousedown — not click — so the textarea doesn't lose
                // focus before we run the selection.
                e.preventDefault()
                onSelect(cmd)
              }}
              onMouseEnter={() => onHover(i)}
              className={cn(
                'flex w-full items-baseline gap-2 rounded-lg px-3 py-2 text-left transition-colors',
                'outline-none focus-visible:ring-3 focus-visible:ring-ring/30',
                selected ? 'bg-muted' : 'hover:bg-muted/50',
              )}
            >
              <span className="font-mono text-body font-medium text-foreground">
                /{cmd.name}
              </span>
              <span className="truncate text-footnote text-muted-foreground">
                {cmd.description}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
