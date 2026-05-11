// Wiki pages section for the sidebar — belief / entity / episode
// docs and any user-defined wiki pages. Lives below the date-axis
// date view because wiki content is agent-synthesized memory,
// not user-authored notes on the time spine; mixing them blurs the
// write-ownership split (see isWikiDoc in docsStore).

import { useMemo } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { IconFileDescription, IconPlus } from '@tabler/icons-react'
import { useDocsStore, isWikiDoc, type KnownDoc } from '@/state/docsStore'
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

  const wikiDocs = useMemo(
    () => knownDocs.filter((d) => !d.archivedAt && isWikiDoc(d)),
    [knownDocs],
  )

  const ensureNotesRoute = () => {
    if (!pathname.startsWith('/notes')) navigate('/notes')
  }

  const handleNew = async () => {
    // Untitled by design: the new doc gets a title input the user
    // fills in immediately. Notion-style — no modal, no prompt, the
    // empty title field IS the prompt. Custom-* slug ensures it
    // never collides with a seed wiki type.
    const slug = await createCustomWikiPage('Untitled')
    if (!slug) return
    setActive(slug)
    ensureNotesRoute()
  }

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Wiki</SidebarGroupLabel>
      <SidebarGroupAction onClick={handleNew} aria-label="New wiki page">
        <IconPlus />
      </SidebarGroupAction>
      <SidebarGroupContent>
        <SidebarMenu>
          {wikiDocs.map((doc) => (
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
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
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
  // Strip the `wiki:` prefix for a tidy default when the doc has no
  // user-set title yet ("belief" reads better than "wiki:belief").
  const fallback = doc.type.replace(/^wiki:/, '')
  return (
    <SidebarMenuButton onClick={onSelect} isActive={isActive}>
      <IconFileDescription />
      <span>{label || fallback}</span>
    </SidebarMenuButton>
  )
}
