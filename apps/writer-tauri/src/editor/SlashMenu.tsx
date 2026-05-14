// Floating slash-command menu. Subscribes to slashStore (which the
// trigger plugin populates) and renders a filtered list of SLASH_ITEMS
// at the trigger's screen coords.
//
// The editor keeps focus the whole time — we never give cmdk an input.
// Instead a capture-phase window keydown listener intercepts ↑ / ↓ /
// Enter / Esc while the menu is active so PM never sees them. Other
// keys flow through to the editor, the trigger plugin updates `query`,
// and we re-filter.
//
// Selecting an item replaces the `/...` text with whatever block the
// item produces, in a single transaction so undo collapses cleanly.

import { useEffect, useMemo, useRef, useState } from 'react'

import { useEditorViewStore } from '@/state/editorViewStore'
import { useSlashStore } from '@/state/slashStore'
import { cn } from '@/lib/utils'
import { SLASH_ITEMS, type SlashItem } from './slashItems'

const MAX_HEIGHT_PX = 256
const VERTICAL_GAP_PX = 4

function filterItems(query: string): SlashItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return SLASH_ITEMS
  return SLASH_ITEMS.filter((it) => {
    if (it.label.toLowerCase().includes(q)) return true
    return it.keywords.some((k) => k.toLowerCase().includes(q))
  })
}

export function SlashMenu() {
  const active = useSlashStore((s) => s.active)
  const view = useEditorViewStore((s) => s.view)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const listRef = useRef<HTMLDivElement | null>(null)

  const items = useMemo(() => filterItems(active?.query ?? ''), [active?.query])

  // Reset highlight when the filter changes — the previous index may
  // point past the end of the new filtered list, and resetting is what
  // a user typing more characters expects.
  useEffect(() => {
    setSelectedIndex(0)
  }, [active?.query])

  // Keep the highlighted row visible as the user arrows through.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-slash-index="${selectedIndex}"]`,
    )
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  // Run an item: delete the `/...` text, then apply the block. One
  // transaction would be ideal, but the preset commands dispatch their
  // own transactions, so we sequence: dispatch the deletion first
  // (collapses range), then call run() against the resulting state.
  const runItem = (item: SlashItem) => {
    if (!view || !active) return
    const tr = view.state.tr.delete(active.from, active.to)
    view.dispatch(tr)
    item.run(view)
    view.focus()
    useSlashStore.getState().setActive(null)
  }

  // Capture-phase keydown — fires before PM's contenteditable handler
  // so Enter doesn't split the paragraph and ↑/↓ don't move the caret.
  // Only installed while the menu is active to avoid leaking listeners
  // into normal editing.
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        e.stopPropagation()
        setSelectedIndex((i) => (items.length === 0 ? 0 : (i + 1) % items.length))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
        setSelectedIndex((i) =>
          items.length === 0 ? 0 : (i - 1 + items.length) % items.length,
        )
        return
      }
      if (e.key === 'Enter') {
        if (items.length === 0) return
        e.preventDefault()
        e.stopPropagation()
        runItem(items[selectedIndex] ?? items[0])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        useSlashStore.getState().setActive(null)
      }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
    // `items` and `selectedIndex` change frequently and runItem closes
    // over `view` / `active` — rebinding each time is correct.
  }, [active, items, selectedIndex, view])

  if (!active) return null

  // Position below the `/` glyph by default; if the menu would clip
  // off the bottom of the viewport, flip above the trigger line.
  const wouldOverflow = active.coords.bottom + MAX_HEIGHT_PX > window.innerHeight
  const top = wouldOverflow
    ? active.coords.top - MAX_HEIGHT_PX - VERTICAL_GAP_PX
    : active.coords.bottom + VERTICAL_GAP_PX

  return (
    <div
      role="listbox"
      aria-label="Slash commands"
      style={{
        position: 'fixed',
        left: active.coords.left,
        top: Math.max(8, top),
        zIndex: 50,
      }}
      className="w-64 rounded-md border border-border bg-popover text-popover-foreground shadow-md"
    >
      {items.length === 0 ? (
        <div className="p-3 text-sm text-muted-foreground">No matches.</div>
      ) : (
        <div
          ref={listRef}
          className="max-h-64 overflow-y-auto p-1"
        >
          {items.map((it, i) => {
            const Icon = it.icon
            const selected = i === selectedIndex
            return (
              <button
                key={it.id}
                type="button"
                data-slash-index={i}
                onMouseDown={(e) => {
                  // mousedown over click so the editor doesn't blur
                  // before we run the selection.
                  e.preventDefault()
                  runItem(it)
                }}
                onMouseEnter={() => setSelectedIndex(i)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors',
                  selected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
                )}
              >
                <Icon size={14} stroke={1.75} />
                <span className="flex-1 truncate">{it.label}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
