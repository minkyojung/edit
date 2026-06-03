// Wiki pages section for the sidebar — a single flat group:
//
//   Wiki    → user-accumulated content pages (`wiki:custom-*`).
//             Karpathy-style flat list: every entity is its own
//             page at the same level, no parent / category
//             nesting. Created via the group-level `+` button.
//             Categories like "People" / "Books" are NOT pages
//             here — entities sit side by side and the user finds
//             them through the list or search.
//
// The machine-only meta pages (`system:log` / `system:index`) are no
// longer surfaced here — they're LLM context artifacts, not human
// navigation targets. Profile (`wiki:profile`) and Conventions
// (`system:conventions`) moved to fixed footer rows (see Sidebar.tsx):
// always-present, low-frequency surfaces that sit beside Archived.
//
// The previous tree-based UI (DocTreeNode + drag/drop + context-
// menu Move to…) was replaced when ingest dropped its
// `suggestNewPageParent` flow. With every new page landing at root
// and no auth-time nesting, the recursive renderer was dead weight.
// Archive lives on each row's context menu via the same content
// menu primitive DocTreeNode used.

import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { PendingDot } from './PendingDot'
import {
  IconArchive,
  IconPlus,
  IconRefresh,
  IconLoader2,
} from '@tabler/icons-react'
import { useDocsStore, getDocPolicy, type KnownDoc } from '@/state/docsStore'
import { useDocLabel } from '@/hooks/useDocLabel'
import { useActiveSlug } from '@/hooks/useActiveSlug'
import { createCustomWikiPage } from '@/state/wikiService'
import { buildViewUrl } from '@/lib/viewUrl'
import { notify } from '@/lib/notify'
import { syncTodayManually } from '@/hooks/useIdleTrigger'
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'

export function WikiSection() {
  const knownDocs = useDocsStore((s) => s.knownDocs)
  const activeSlug = useActiveSlug()
  const sidebarTab = useDocsStore((s) => s.sidebarTab)
  const dayAnchor = useDocsStore((s) => s.dayAnchor)
  const monthAnchor = useDocsStore((s) => s.monthAnchor)
  const archiveDoc = useDocsStore((s) => s.archiveDoc)
  const navigate = useNavigate()

  // Jumping to a wiki page preserves whichever date-view the sidebar
  // is currently on — the user's "where am I in time" context shouldn't
  // collapse just because they opened a wiki page. Only the slug
  // portion of the URL changes.
  const navigateToSlug = (slug: string) => {
    navigate(buildViewUrl({ tab: sidebarTab, dayAnchor, monthAnchor, slug }))
  }

  // Flat list of all live wiki content pages. Order = catalog
  // insertion order (zustand persist preserves array order); no sort
  // applied so the most recent creations land at the bottom and the
  // user's older pages stay where they were.
  //
  // Profile is excluded — it now lives as a fixed footer row alongside
  // Conventions / Archived (low-frequency, always-present surfaces),
  // not in the browsable wiki list.
  const wikiDocs = useMemo(
    () =>
      knownDocs.filter(
        (d) =>
          !d.archivedAt &&
          getDocPolicy(d).sidebarGroup === 'wiki' &&
          d.type !== 'wiki:profile',
      ),
    [knownDocs],
  )

  const [syncing, setSyncing] = useState(false)
  const handleSyncClick = async () => {
    if (syncing) return
    setSyncing(true)
    try {
      const proposals = await syncTodayManually()
      // syncTodayManually return contract:
      //   null  → no daily to target. Stay quiet.
      //   < 0   → ingest pass errored. The internal toast (auth or
      //           wikiSyncFailed) has already fired — skip our
      //           success toast to avoid the "Sync failed" +
      //           "Synced — nothing new" double-toast confusion.
      //   ≥ 0   → success; report the count.
      if (proposals === null) return
      if (proposals < 0) return
      notify.wikiSynced({ proposals })
    } catch (err) {
      console.warn('[wiki] manual sync failed', err)
      notify.wikiSyncFailed()
    } finally {
      setSyncing(false)
    }
  }

  const handleNewRoot = async () => {
    const slug = await createCustomWikiPage('')
    if (!slug) return
    navigateToSlug(slug)
  }

  const onSelectDoc = (slug: string) => navigateToSlug(slug)
  const onArchiveDoc = (slug: string) => {
    const next = archiveDoc(slug)
    if (next) navigateToSlug(next)
  }

  return (
    <>
      <SidebarGroup>
        <SidebarGroupLabel>Wiki</SidebarGroupLabel>
        {/* Sync sits left of the `+` so the safer action gets the
            inner slot. SidebarGroupAction is absolute-positioned
            at right-3; the override on the sync button shifts it
            left by the icon-width + gap so the two don't overlap. */}
        <SidebarGroupAction
          className="right-9"
          onClick={handleSyncClick}
          disabled={syncing}
          aria-label="Sync today's daily to wiki"
        >
          {syncing ? <IconLoader2 className="animate-spin" /> : <IconRefresh />}
        </SidebarGroupAction>
        <SidebarGroupAction onClick={handleNewRoot} aria-label="New wiki page">
          <IconPlus />
        </SidebarGroupAction>
        <SidebarGroupContent>
          <SidebarMenu>
            {wikiDocs.map((doc) => (
              <SidebarMenuItem key={doc.slug} data-slug={doc.slug}>
                <WikiRow
                  doc={doc}
                  isActive={doc.slug === activeSlug}
                  onSelect={() => onSelectDoc(doc.slug)}
                  onArchive={() => onArchiveDoc(doc.slug)}
                />
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    </>
  )
}

function WikiRow({
  doc,
  isActive,
  onSelect,
  onArchive,
}: {
  doc: KnownDoc
  isActive: boolean
  onSelect: () => void
  onArchive: () => void
}) {
  const label = useDocLabel(doc.slug)
  const fallback = doc.type.replace(/^wiki:custom-/, '')
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <SidebarMenuButton onClick={onSelect} isActive={isActive}>
          <PendingDot slug={doc.slug} />
          <span>{label || fallback}</span>
        </SidebarMenuButton>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={onArchive}>
          <IconArchive className="mr-2 h-4 w-4" />
          Archive
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
