// Presentational slash menu for the CodeMirror editor. Shares the chat
// SlashPalette's design vocabulary (rounded-xl popover panel, rounded-lg rows,
// bg-muted selection, text-body/footnote) so both menus read as one product —
// but this one is OWNED markup, not a skin over @codemirror/autocomplete.
//
// Pure presentational: `slashMenu.tsx` owns open/close/query/selectedIndex as a
// CodeMirror StateField and mounts this via a `showTooltip` TooltipView. No
// positioning here — CM anchors the tooltip at the caret.

import { useEffect, useRef } from 'react'
import {
  type LucideIcon,
  Type,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  ListTodo,
  TextQuote,
  Minus,
  Code2,
  Image,
  FileText,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { SlashItem } from '@/prototypes/slashCommands'

const ICONS: Record<string, LucideIcon> = {
  text: Type,
  h1: Heading1,
  h2: Heading2,
  h3: Heading3,
  bullet: List,
  numbered: ListOrdered,
  todo: ListTodo,
  quote: TextQuote,
  divider: Minus,
  code: Code2,
  image: Image,
}

interface Props {
  items: SlashItem[]
  selectedIndex: number
  onSelect: (index: number) => void
  onHover: (index: number) => void
}

export function EditorSlashMenu({ items, selectedIndex, onSelect, onHover }: Props) {
  const listRef = useRef<HTMLDivElement | null>(null)

  // Keep the highlighted row in view while arrowing through.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-slash-index="${selectedIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  return (
    <div className="w-72 overflow-hidden rounded-xl border border-border bg-popover shadow-md">
      <div ref={listRef} className="max-h-72 overflow-y-auto p-1">
        {items.map((it, i) => {
          // Templates get a generic file icon (their id is dynamic:
          // `tmpl:<name>`); built-in blocks look up by their fixed id.
          const Icon = it.kind === 'template' ? FileText : ICONS[it.id]
          const selected = i === selectedIndex
          return (
            <button
              key={it.id}
              type="button"
              data-slash-index={i}
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
              {Icon && (
                <Icon className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
              )}
              <span className="flex-1 text-body font-medium text-foreground">{it.label}</span>
              {it.detail && (
                <span className="shrink-0 font-mono text-footnote text-muted-foreground">
                  {it.detail}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
