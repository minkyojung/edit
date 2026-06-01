// Read Later entry for the sidebar — a single collapsed row, NOT the
// full queue. The queue itself lives at the `/read-later` route
// (ReadLaterQueue): clicking this row navigates there. Collapsing to one
// line is the point — the old flat list grew unbounded as articles piled
// up. The row shows the unread count; the hover `+` opens the
// Save-to-Read-Later dialog.

import { useMemo } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { IconBookmarks, IconPlus } from '@tabler/icons-react'
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

  const hasArticles = useMemo(
    () => knownDocs.some((d) => d.type === 'article' && !d.archivedAt),
    [knownDocs],
  )
  const unreadCount = useMemo(
    () =>
      knownDocs.filter(
        (d) => d.type === 'article' && !d.archivedAt && !d.readAt,
      ).length,
    [knownDocs],
  )

  // Empty queue: hide the row so it isn't a bare heading. The `+` stays
  // reachable here, and the Command Palette command is the other entry
  // point until the first save.
  if (!hasArticles) {
    return (
      <SidebarGroup>
        <SidebarGroupLabel>Read Later</SidebarGroupLabel>
        <SidebarGroupAction
          onClick={() => openSaveArticle()}
          aria-label="Save a URL to Read Later"
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
              <IconBookmarks />
              <span className="flex-1 truncate">Read Later</span>
              {unreadCount > 0 && (
                <span className="text-xs text-muted-foreground">
                  {unreadCount}
                </span>
              )}
            </SidebarMenuButton>
            <SidebarMenuAction
              showOnHover
              onClick={() => openSaveArticle()}
              aria-label="Save a URL to Read Later"
            >
              <IconPlus />
            </SidebarMenuAction>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}
