// Wiki pages section for the sidebar — split into two groups that
// mirror Karpathy's schema-vs-wiki separation:
//
//   System  → agent meta surface (conventions / log / index).
//             Read-only from the user's perspective — the LLM
//             writes / maintains these pages on dedicated prompt
//             channels (not via the wiki catalog), so they get
//             their own visual region with no `+` button.
//
//   Wiki    → user-accumulated content pages (`wiki:custom-*`).
//             Created via the `+` button or via the LLM's
//             `suggestNewPage` flow.
//
// Lives below the date-axis date view because both groups are
// agent-managed memory, not user-authored notes on the time
// spine; mixing them blurs the write-ownership split (see
// isWikiDoc in docsStore).

import { useMemo } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { IconFileDescription, IconPlus } from '@tabler/icons-react'
import { useDocsStore, type KnownDoc } from '@/state/docsStore'
import { useDocLabel } from '@/hooks/useDocLabel'
import { createCustomWikiPage } from '@/state/wikiService'
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'

export function WikiSection() {
  const knownDocs = useDocsStore((s) => s.knownDocs)
  const activeSlug = useDocsStore((s) => s.activeSlug)
  const setActive = useDocsStore((s) => s.setActive)
  const navigate = useNavigate()
  const { pathname } = useLocation()

  const systemDocs = useMemo(
    () =>
      knownDocs.filter((d) => !d.archivedAt && d.type.startsWith('system:')),
    [knownDocs],
  )
  const wikiDocs = useMemo(
    () => knownDocs.filter((d) => !d.archivedAt && d.type.startsWith('wiki:')),
    [knownDocs],
  )

  const ensureNotesRoute = () => {
    if (!pathname.startsWith('/notes')) navigate('/notes')
  }

  const handleNew = async () => {
    // Empty name by design: the new doc gets a title input the user
    // fills in immediately. Notion-style — no modal, no prompt, the
    // empty title field IS the prompt. The sidebar / palette display
    // 'Untitled' as a fallback in useDocLabel until the user types
    // a real name. Custom-* slug ensures it never collides with a
    // system page type.
    const slug = await createCustomWikiPage('')
    if (!slug) return
    setActive(slug)
    ensureNotesRoute()
  }

  const renderRow = (doc: KnownDoc) => (
    <SidebarMenuItem key={doc.slug} data-slug={doc.slug}>
      <WikiRow
        doc={doc}
        isActive={doc.slug === activeSlug}
        onSelect={() => {
          setActive(doc.slug)
          ensureNotesRoute()
        }}
      />
    </SidebarMenuItem>
  )

  return (
    <>
      {/* System group — render only when at least one system page
          exists. They're created lazily on first ingest, so the
          group stays hidden until then. No `+` button: the user
          doesn't author system pages. */}
      {systemDocs.length > 0 && (
        <SidebarGroup>
          <SidebarGroupLabel>System</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>{systemDocs.map(renderRow)}</SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      )}
      <SidebarGroup>
        <SidebarGroupLabel>Wiki</SidebarGroupLabel>
        <SidebarGroupAction onClick={handleNew} aria-label="New wiki page">
          <IconPlus />
        </SidebarGroupAction>
        <SidebarGroupContent>
          <SidebarMenu>{wikiDocs.map(renderRow)}</SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    </>
  )
}

function WikiRow({
  doc,
  isActive,
  onSelect,
}: {
  doc: KnownDoc
  isActive: boolean
  onSelect: () => void
}) {
  const label = useDocLabel(doc.slug)
  // Strip the agent prefix for a tidy default when the doc has no
  // user-set title yet ("log" reads better than "system:log",
  // "belief" reads better than "wiki:belief"). useDocLabel already
  // handles this for system / custom pages — fallback is just the
  // last-resort path in case label resolution returns empty.
  const fallback = doc.type.replace(/^(?:wiki|system):/, '')
  return (
    <SidebarMenuButton onClick={onSelect} isActive={isActive}>
      <IconFileDescription />
      <span>{label || fallback}</span>
    </SidebarMenuButton>
  )
}
