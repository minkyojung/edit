// Presentational `[[` wikilink menu — twin of <EditorSlashMenu>, sharing the
// same panel/row vocabulary (rounded-xl popover, rounded-lg rows, bg-muted
// selection, text-body/footnote) so the `/` menu and the `[[` menu read as one
// product. Pure presentational: `wikilinkMenu.tsx` owns state + positioning.

import { useEffect, useRef } from 'react'
import { FileText, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { WikilinkItem } from './wikilinkMenu'

interface Props {
  items: WikilinkItem[]
  selectedIndex: number
  onSelect: (index: number) => void
  onHover: (index: number) => void
}

export function EditorWikilinkMenu({ items, selectedIndex, onSelect, onHover }: Props) {
  const listRef = useRef<HTMLDivElement | null>(null)

  // Keep the highlighted row in view while arrowing through.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-wikilink-index="${selectedIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  return (
    <div className="w-72 overflow-hidden rounded-xl border border-border bg-popover shadow-md">
      <div ref={listRef} className="max-h-72 overflow-y-auto p-1">
        {items.map((it, i) => {
          const Icon = it.create ? Plus : FileText
          const selected = i === selectedIndex
          return (
            <button
              key={it.create ? `create:${it.title}` : it.title}
              type="button"
              data-wikilink-index={i}
              // mousedown (not click) + preventDefault → the editor keeps focus
              // and the selection range stays intact for `apply`.
              onMouseDown={(e) => {
                e.preventDefault()
                onSelect(i)
              }}
              onMouseEnter={() => onHover(i)}
              className={cn(
                'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors',
                selected ? 'bg-muted' : 'hover:bg-muted/50',
              )}
            >
              <Icon className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
              <span className="flex-1 truncate text-body font-medium text-foreground">
                {it.title}
              </span>
              {it.create && (
                <span className="shrink-0 text-footnote text-muted-foreground">New note</span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
