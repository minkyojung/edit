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
import { IconTarget, IconPlus, IconX } from '@tabler/icons-react'
import { Tabs as TabsPrimitive } from 'radix-ui'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useDocsStore } from '@/state/docsStore'
import { useDocTitle } from '@/hooks/useDocTitle'

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
        className="flex flex-1 items-stretch gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {openSlugs.map((slug) => (
          <DocTab
            key={slug}
            slug={slug}
            isActive={slug === activeSlug}
            canClose={openSlugs.length > 1}
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
  canClose,
  onClose,
}: {
  slug: string
  isActive: boolean
  canClose: boolean
  onClose: () => void
}) {
  const handle = useDocsStore((s) => s.handles[slug])
  const knownDoc = useDocsStore((s) =>
    s.knownDocs.find((d) => d.slug === slug),
  )
  const { title } = useDocTitle(handle?.ydoc ?? null)
  // Daily entries are the day's anchor; the design doc forbids
  // archiving/deleting them. Closing the tab isn't quite either
  // (knownDocs survives, the tab just leaves openSlugs), but it
  // makes "today" disappear from the strip — confusing, since the
  // bootstrap promise is "you always land on today". Hide the X
  // for daily tabs and let users close writing tabs only.
  const isDaily = knownDoc?.type === 'daily'
  const showClose = canClose && !isDaily

  return (
    <TabsPrimitive.Trigger
      value={slug}
      className={cn(
        'group flex max-w-[200px] shrink-0 items-center gap-1.5 px-1.5 text-[13px] font-medium transition-colors',
        'border-b',
        'outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
        isActive
          ? 'border-foreground text-foreground'
          : 'border-transparent text-muted-foreground hover:text-foreground',
      )}
    >
      <IconTarget size={12} stroke={1.75} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">{title || 'Untitled'}</span>
      {showClose && (
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
      )}
    </TabsPrimitive.Trigger>
  )
}
