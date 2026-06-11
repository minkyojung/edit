// Inbox entry for the sidebar — a single collapsed row, NOT the full
// queue. The queue itself lives at the `/read-later` route
// (ReadLaterQueue): clicking this row navigates there. Collapsing to one
// line is the point — the list grew unbounded as captures piled up. The
// row shows the unprocessed count; the hover `+` opens the Add-to-Inbox
// dialog. Holds both saved articles and captured YouTube videos.

import { useMemo } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { IconInbox, IconPlus } from '@tabler/icons-react'
import { useDocsStore } from '@/state/docsStore'
import { useSaveArticleDialogStore } from '@/state/saveArticleDialogStore'
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'

export function ArticlesSection() {
  const knownDocs = useDocsStore((s) => s.knownDocs)
  const openSaveArticle = useSaveArticleDialogStore((s) => s.openDialog)
  const navigate = useNavigate()
  const { pathname } = useLocation()

  const hasItems = useMemo(
    () =>
      knownDocs.some(
        (d) => (d.type === 'article' || d.type === 'youtube') && !d.archivedAt,
      ),
    [knownDocs],
  )
  const unreadCount = useMemo(
    () =>
      knownDocs.filter(
        (d) =>
          (d.type === 'article' || d.type === 'youtube') &&
          !d.archivedAt &&
          !d.readAt,
      ).length,
    [knownDocs],
  )

  // Empty queue: hide the row so it isn't a bare heading. The `+` stays
  // reachable here, and the Command Palette command is the other entry
  // point until the first save.
  if (!hasItems) {
    return (
      <SidebarGroup>
        <SidebarGroupLabel>Inbox</SidebarGroupLabel>
        <SidebarGroupAction
          onClick={() => openSaveArticle()}
          aria-label="Add a URL to Inbox"
        >
          <IconPlus />
        </SidebarGroupAction>
      </SidebarGroup>
    )
  }

  return (
    <SidebarGroup>
      <SidebarGroupContent>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={() => navigate('/read-later')}
              isActive={pathname === '/read-later'}
            >
              <IconInbox />
              <span className="flex-1 truncate">Inbox</span>
              {unreadCount > 0 && (
                <span className="text-xs text-muted-foreground">
                  {unreadCount}
                </span>
              )}
            </SidebarMenuButton>
            <SidebarMenuAction
              showOnHover
              onClick={() => openSaveArticle()}
              aria-label="Add a URL to Inbox"
            >
              <IconPlus />
            </SidebarMenuAction>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}
