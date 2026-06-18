// Fixed footer rows for the always-present, low-frequency surfaces: Profile
// (`wiki:profile`) and a single Skills entry point. They sit beside Archived
// rather than in the browsable wiki list — singletons you visit rarely.
// Clicking opens the surface in the main area (Skills opens the SkillsPage;
// Profile opens in the editor).
//
// The vault rules document (`CLAUDE.md`) is an ordinary root-level note, so
// it shows up directly in the file tree — no dedicated footer row needed.
//
// Profile is lazy-created, so a user who skipped onboarding may not have it
// yet — clicking ensures the page exists first.

import { useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { IconUser, IconBolt, IconPalette } from '@tabler/icons-react'
import { SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar'
import { useDocsStore } from '@/state/docsStore'
import { usePendingChangesStore } from '@/state/pendingChangesStore'
import { useActiveSlug } from '@/hooks/useActiveSlug'
import { ensureProfileWikiSlug } from '@/state/wikiService'
import { buildViewUrl } from '@/lib/viewUrl'
import { cn } from '@/lib/utils'

export function WikiMetaRows() {
  const knownDocs = useDocsStore((s) => s.knownDocs)
  const sidebarTab = useDocsStore((s) => s.sidebarTab)
  const dayAnchor = useDocsStore((s) => s.dayAnchor)
  const monthAnchor = useDocsStore((s) => s.monthAnchor)
  const activeSlug = useActiveSlug()
  const navigate = useNavigate()
  const location = useLocation()

  // Existing slugs, if the pages have been created. Used for the
  // active-highlight and Profile's pending indicator. May be undefined
  // until the first click lazily creates the page.
  const profileSlug = knownDocs.find(
    (d) => d.type === 'wiki:profile' && !d.archivedAt,
  )?.slug

  // Profile receives ingest banner proposals (the Background zone).
  // Mirror PendingDot's "unviewed" signal as an icon tint so a queued
  // proposal on Profile is still noticeable from the footer.
  const profileUnviewed = usePendingChangesStore((s) =>
    Object.values(s.byId).some(
      (c) =>
        c.pageSlug === profileSlug &&
        c.status !== 'rejected' &&
        c.viewedAt === null,
    ),
  )

  const [busy, setBusy] = useState(false)

  const open = async (ensure: () => Promise<string | null>) => {
    if (busy) return
    setBusy(true)
    try {
      const slug = await ensure()
      if (!slug) return
      navigate(buildViewUrl({ tab: sidebarTab, dayAnchor, monthAnchor, slug }))
    } catch (err) {
      console.warn('[wiki] open meta page failed', err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <SidebarMenuItem>
        <SidebarMenuButton
          className="text-sidebar-foreground/70"
          isActive={!!profileSlug && profileSlug === activeSlug}
          onClick={() => open(ensureProfileWikiSlug)}
          aria-label="Profile"
        >
          <IconUser
            size={16}
            stroke={1.5}
            className={cn(profileUnviewed && 'text-info')}
          />
          <span className="flex-1 text-left">Profile</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
      <SidebarMenuItem>
        <SidebarMenuButton
          className="text-sidebar-foreground/70"
          isActive={location.pathname === '/skills'}
          onClick={() => navigate('/skills')}
          aria-label="Skills"
        >
          <IconBolt size={16} stroke={1.5} />
          <span className="flex-1 text-left">Skills</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
      <SidebarMenuItem>
        <SidebarMenuButton
          className="text-sidebar-foreground/70"
          isActive={location.pathname === '/gallery'}
          onClick={() => navigate('/gallery')}
          aria-label="Gallery"
        >
          <IconPalette size={16} stroke={1.5} />
          <span className="flex-1 text-left">Gallery</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </>
  )
}
