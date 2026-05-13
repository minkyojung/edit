// Document tab strip in the editor header. Mirrors ThreadTabs in
// shape — Radix Tabs primitive for tablist semantics + keyboard nav,
// plus a global ⌘⇧[ / ⌘⇧] shortcut that fires only when focus is
// inside the editor area (so the same chord can swap chat threads
// when focus is in the chat panel without conflict).
//
// Each tab pulls its title live from the doc's Y.Text, so renaming
// a doc updates the tab label in place. Tabs whose handle hasn't
// been opened yet show "Untitled" — the title materializes the
// first time the user activates that tab and triggers the ydoc
// connection.

import { useEffect, useRef } from 'react'
import { IconFileDescription, IconPlus, IconX } from '@tabler/icons-react'
import { Tabs as TabsPrimitive } from 'radix-ui'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useDocsStore } from '@/state/docsStore'
import { useDocLabel } from '@/hooks/useDocLabel'

export function EditorTabs() {
  const openSlugs = useDocsStore((s) => s.openSlugs)
  const activeSlug = useDocsStore((s) => s.activeSlug)
  const setActive = useDocsStore((s) => s.setActive)
  const closeDoc = useDocsStore((s) => s.closeDoc)
  const createNew = useDocsStore((s) => s.createNew)

  // Focus-scoped ⌘⇧[ / ⌘⇧] — only fire when something inside the
  // editor area has focus, so the chat panel keeps its own scope of
  // the same chord. We anchor via the tablist's containing element.
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (openSlugs.length <= 1) return
    const handler = (e: KeyboardEvent) => {
      if (!e.shiftKey || !(e.metaKey || e.ctrlKey)) return
      const isPrev = e.key === '[' || e.code === 'BracketLeft'
      const isNext = e.key === ']' || e.code === 'BracketRight'
      if (!isPrev && !isNext) return
      // Only act if focus is inside the editor surface. ProseMirror's
      // contenteditable counts; the title input counts; nothing
      // outside this column does.
      const editorPanel = rootRef.current?.closest('[data-editor-panel]')
      if (!editorPanel) return
      if (!editorPanel.contains(document.activeElement)) return
      e.preventDefault()
      const idx = openSlugs.findIndex((s) => s === activeSlug)
      const cur = idx < 0 ? 0 : idx
      const next = isPrev
        ? (cur - 1 + openSlugs.length) % openSlugs.length
        : (cur + 1) % openSlugs.length
      setActive(openSlugs[next])
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [openSlugs, activeSlug, setActive])

  return (
    <TabsPrimitive.Root
      ref={rootRef}
      value={activeSlug ?? ''}
      onValueChange={setActive}
      className="flex flex-1 items-stretch gap-1 overflow-hidden"
    >
      <TabsPrimitive.List
        aria-label="Documents"
        className="flex flex-1 items-stretch overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {openSlugs.map((slug) => (
          <DocTab
            key={slug}
            slug={slug}
            isActive={slug === activeSlug}
            onClose={() => closeDoc(slug)}
          />
        ))}

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => {
                createNew().catch((err) =>
                  console.error('[docs] createNew failed', err),
                )
              }}
              className={cn(
                'flex size-7 shrink-0 items-center justify-center self-center rounded-md text-muted-foreground transition-colors',
                'outline-none focus-visible:ring-3 focus-visible:ring-ring/30',
                'hover:bg-accent hover:text-foreground',
              )}
              aria-label="New document"
            >
              <IconPlus size={14} stroke={1.75} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">New document</TooltipContent>
        </Tooltip>
      </TabsPrimitive.List>
    </TabsPrimitive.Root>
  )
}

function DocTab({
  slug,
  isActive,
  onClose,
}: {
  slug: string
  isActive: boolean
  onClose: () => void
}) {
  const label = useDocLabel(slug)
  // Every tab is closeable, including today's daily. closeDoc (and the
  // archive/delete paths in docsStore) reopens today's daily in the
  // same tick if the strip would otherwise be empty, so this surface
  // doesn't need its own "never close the last one" guard.

  return (
    <TabsPrimitive.Trigger
      value={slug}
      className={cn(
        'group relative flex w-48 shrink-0 items-center gap-1.5 pl-2 pr-1.5 text-left text-sm font-medium transition-colors',
        'outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40',
        isActive
          // Active tab paints in the canvas color. The header's bottom
          // hairline is an inset box-shadow on the parent, so the tab's
          // background naturally paints over the 1px strip beneath it
          // and the divider disappears under the active tab.
          ? 'bg-background text-foreground'
          : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
      )}
    >
      <IconFileDescription size={14} stroke={1.75} className="shrink-0 opacity-70" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span
        role="button"
        tabIndex={0}
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            e.stopPropagation()
            onClose()
          }
        }}
        aria-label="Close document"
        className={cn(
          'flex h-4 w-4 shrink-0 items-center justify-center rounded transition-opacity hover:bg-foreground/10',
          'outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
          'opacity-0 group-hover:opacity-60 group-focus-visible:opacity-60 hover:!opacity-100',
          isActive && 'opacity-60',
        )}
      >
        <IconX size={12} stroke={2} />
      </span>
    </TabsPrimitive.Trigger>
  )
}
