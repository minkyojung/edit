// Read Later section for the sidebar — the queue of saved articles
// (`type === 'article'`). Mirrors WikiSection: a flat group, newest
// first. Each row shows the site favicon + title; read articles dim.
// Clicking opens the article in the editor (its body is the extracted
// Markdown, so the editor IS the reader). Context menu toggles read
// state and archives. The `+` opens the Save-to-Read-Later dialog.

import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  IconArchive,
  IconCircleCheck,
  IconCircleDot,
  IconPlus,
  IconWorld,
} from '@tabler/icons-react'
import { useDocsStore, type KnownDoc } from '@/state/docsStore'
import { useActiveSlug } from '@/hooks/useActiveSlug'
import { useSaveArticleDialogStore } from '@/state/saveArticleDialogStore'
import { buildViewUrl } from '@/lib/viewUrl'
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

export function ArticlesSection() {
  const knownDocs = useDocsStore((s) => s.knownDocs)
  const activeSlug = useActiveSlug()
  const sidebarTab = useDocsStore((s) => s.sidebarTab)
  const dayAnchor = useDocsStore((s) => s.dayAnchor)
  const monthAnchor = useDocsStore((s) => s.monthAnchor)
  const archiveDoc = useDocsStore((s) => s.archiveDoc)
  const setArticleRead = useDocsStore((s) => s.setArticleRead)
  const openSaveArticle = useSaveArticleDialogStore((s) => s.openDialog)
  const navigate = useNavigate()

  const navigateToSlug = (slug: string) => {
    navigate(buildViewUrl({ tab: sidebarTab, dayAnchor, monthAnchor, slug }))
  }

  // Live articles, newest save first. savedAt is an ISO string so a
  // string compare sorts chronologically; missing savedAt sinks to the
  // bottom.
  const articles = useMemo(
    () =>
      knownDocs
        .filter((d) => d.type === 'article' && !d.archivedAt)
        .sort((a, b) => (b.savedAt ?? '').localeCompare(a.savedAt ?? '')),
    [knownDocs],
  )

  // Empty queue: hide the section entirely so it doesn't sit as a bare
  // heading. The `+` lives here too, so once it's hidden the Command
  // Palette command is the entry point until the first save.
  if (articles.length === 0) {
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

  const onArchiveDoc = (slug: string) => {
    const next = archiveDoc(slug)
    if (next) navigateToSlug(next)
  }

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Read Later</SidebarGroupLabel>
      <SidebarGroupAction
        onClick={() => openSaveArticle()}
        aria-label="Save a URL to Read Later"
      >
        <IconPlus />
      </SidebarGroupAction>
      <SidebarGroupContent>
        <SidebarMenu>
          {articles.map((doc) => (
            <SidebarMenuItem key={doc.slug} data-slug={doc.slug}>
              <ArticleRow
                doc={doc}
                isActive={doc.slug === activeSlug}
                onSelect={() => navigateToSlug(doc.slug)}
                onToggleRead={() => setArticleRead(doc.slug, !doc.readAt)}
                onArchive={() => onArchiveDoc(doc.slug)}
              />
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}

function ArticleRow({
  doc,
  isActive,
  onSelect,
  onToggleRead,
  onArchive,
}: {
  doc: KnownDoc
  isActive: boolean
  onSelect: () => void
  onToggleRead: () => void
  onArchive: () => void
}) {
  const isRead = !!doc.readAt
  const title = doc.title?.trim() || 'Untitled'
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <SidebarMenuButton
          onClick={onSelect}
          isActive={isActive}
          className={isRead ? 'opacity-55' : undefined}
          title={doc.siteName ? `${title} — ${doc.siteName}` : title}
        >
          {doc.faviconUrl ? (
            <img
              src={doc.faviconUrl}
              alt=""
              className="size-4 shrink-0 rounded-sm"
              // Hide a broken favicon rather than showing the broken-image
              // glyph; the title still identifies the article.
              onError={(e) => {
                e.currentTarget.style.visibility = 'hidden'
              }}
            />
          ) : (
            <IconWorld className="size-4 shrink-0 text-muted-foreground" />
          )}
          <span className="flex-1 truncate">{title}</span>
        </SidebarMenuButton>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={onToggleRead}>
          {isRead ? (
            <IconCircleDot className="mr-2 h-4 w-4" />
          ) : (
            <IconCircleCheck className="mr-2 h-4 w-4" />
          )}
          {isRead ? 'Mark unread' : 'Mark read'}
        </ContextMenuItem>
        <ContextMenuItem onSelect={onArchive}>
          <IconArchive className="mr-2 h-4 w-4" />
          Archive
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
