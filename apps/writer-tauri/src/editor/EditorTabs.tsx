// Document tab strip in the editor header. Built on Radix Tabs
// primitive for tablist semantics + keyboard nav, with a global
// ⌘⇧[ / ⌘⇧] shortcut for cycling tabs. The shortcut is the only
// global tab-switching chord in the app — chat threads no longer
// own a competing ⌘⇧[ / ⌘⇧] handler, so we don't need a focus
// gate to disambiguate.
//
// Each tab pulls its label live from the doc's body (see
// useDocLabel). Tabs whose handle hasn't been opened yet fall back
// to the cached knownDocs.title or 'Untitled'.

import { useCallback, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
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
import { useChatRunningForSlug } from '@/hooks/useChatRunningForSlug'
import { useActiveSlug } from '@/hooks/useActiveSlug'
import { buildViewUrl } from '@/lib/viewUrl'
import { ChatRunningIcon } from '@/components/icons/ChatRunningIcon'

export function EditorTabs() {
  const openSlugs = useDocsStore((s) => s.openSlugs)
  const activeSlug = useActiveSlug()
  const sidebarTab = useDocsStore((s) => s.sidebarTab)
  const dayAnchor = useDocsStore((s) => s.dayAnchor)
  const monthAnchor = useDocsStore((s) => s.monthAnchor)
  const closeDoc = useDocsStore((s) => s.closeDoc)
  const createNew = useDocsStore((s) => s.createNew)
  const navigate = useNavigate()

  // Switching a tab preserves the sidebar view & anchor — only the
  // open-slug portion of the URL moves. Wrapping navigate keeps the
  // cycle shortcut and the click handler going through the same code
  // path so a future change (e.g. adding a query parameter on tab
  // change) lands in one place.
  const goToSlug = useCallback(
    (slug: string) => {
      navigate(buildViewUrl({ tab: sidebarTab, dayAnchor, monthAnchor, slug }))
    },
    [navigate, sidebarTab, dayAnchor, monthAnchor],
  )

  // ⌘⇧[ / ⌘⇧] cycles tabs. Global — no focus gate. The chord
  // isn't bound to anything else in any input we render, so a
  // user typing in the wikilink palette or tab rename input can
  // still cycle docs without surprises.
  useEffect(() => {
    if (openSlugs.length <= 1) return
    const handler = (e: KeyboardEvent) => {
      if (!e.shiftKey || !(e.metaKey || e.ctrlKey)) return
      const isPrev = e.key === '[' || e.code === 'BracketLeft'
      const isNext = e.key === ']' || e.code === 'BracketRight'
      if (!isPrev && !isNext) return
      e.preventDefault()
      const idx = openSlugs.findIndex((s) => s === activeSlug)
      const cur = idx < 0 ? 0 : idx
      const next = isPrev
        ? (cur - 1 + openSlugs.length) % openSlugs.length
        : (cur + 1) % openSlugs.length
      goToSlug(openSlugs[next])
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [openSlugs, activeSlug, goToSlug])

  return (
    <TabsPrimitive.Root
      value={activeSlug ?? ''}
      onValueChange={goToSlug}
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
            onClose={() => {
              const next = closeDoc(slug)
              if (next) goToSlug(next)
            }}
          />
        ))}

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => {
                createNew()
                  .then((slug) => goToSlug(slug))
                  .catch((err) => console.error('[docs] createNew failed', err))
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
  const isRunning = useChatRunningForSlug(slug)
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
      {isRunning ? (
        <ChatRunningIcon size={14} className="shrink-0 opacity-70" />
      ) : (
        <IconFileDescription size={14} stroke={1.75} className="shrink-0 opacity-70" />
      )}
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
