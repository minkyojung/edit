// Active document title in the editor header.
//
// Replaces the multi-tab strip with a single active-doc label,
// following the Apple Notes / Pages pattern: the header reads as a
// "you are here" breadcrumb rather than a tab bar. Multi-doc state
// (openSlugs, closeDoc, createNew) lives in docsStore unchanged —
// navigation between open docs flows through the sidebar TreeRow
// active-state and the ⌘⇧[ / ⌘⇧] cycle shortcut kept below.

import { useCallback, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { IconFileDescription } from '@tabler/icons-react'
import { useDocsStore } from '@/state/docsStore'
import { useDocLabel } from '@/hooks/useDocLabel'
import { useChatRunningForSlug } from '@/hooks/useChatRunningForSlug'
import { useActiveSlug } from '@/hooks/useActiveSlug'
import { buildViewUrl } from '@/lib/viewUrl'
import { ChatRunningIcon } from '@/components/icons/ChatRunningIcon'
import { usePageHeaderStore } from '@/state/pageHeaderStore'
import { cn } from '@/lib/utils'

export function EditorTabs() {
  const openSlugs = useDocsStore((s) => s.openSlugs)
  const activeSlug = useActiveSlug()
  const sidebarTab = useDocsStore((s) => s.sidebarTab)
  const dayAnchor = useDocsStore((s) => s.dayAnchor)
  const monthAnchor = useDocsStore((s) => s.monthAnchor)
  const navigate = useNavigate()

  const activeLabel = useDocLabel(activeSlug ?? '')
  const isRunning = useChatRunningForSlug(activeSlug)
  // Apple Notes pattern: the header label is hidden while the in-body
  // PageHeader is visible (no duplicate titles), and fades in once
  // the body title scrolls under the header. PageHeader publishes via
  // pageHeaderStore.
  const titleInView = usePageHeaderStore((s) => s.titleInView)
  const showHeaderTitle = !titleInView

  const goToSlug = useCallback(
    (slug: string) => {
      navigate(buildViewUrl({ tab: sidebarTab, dayAnchor, monthAnchor, slug }))
    },
    [navigate, sidebarTab, dayAnchor, monthAnchor],
  )

  // ⌘⇧[ / ⌘⇧] cycles between open docs. The visual tab strip is gone
  // but the cycle behavior stays — feedback is the sidebar TreeRow's
  // active-state and this header's title flipping.
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
    <div
      className={cn(
        'flex min-w-0 items-center gap-1.5 px-2 transition-opacity duration-200 ease-tahoe',
        showHeaderTitle ? 'opacity-100' : 'pointer-events-none opacity-0',
      )}
      aria-hidden={!showHeaderTitle}
    >
      {isRunning ? (
        <ChatRunningIcon size={14} className="shrink-0 opacity-70" />
      ) : (
        <IconFileDescription
          size={14}
          stroke={1.75}
          className="shrink-0 text-muted-foreground"
        />
      )}
      <span className="truncate text-body font-medium text-foreground">
        {activeLabel || 'Untitled'}
      </span>
    </div>
  )
}
