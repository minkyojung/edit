// The Read Later queue — a full-area center view (route `/read-later`)
// listing every saved article. Replaces the old unbounded sidebar list:
// the sidebar now collapses to a single entry that navigates here, so it
// stays one line no matter how many articles pile up.
//
// Pure read over `knownDocs` (captured notes — those with a `sourceUrl`);
// no new persistence.
// Filter (unread/read/all) + search are local state. A row click opens
// the article in the editor (the editor IS the reader); the context menu
// toggles read state and archives — same actions as the sidebar used to
// expose, reusing the docsStore `setArticleRead` / `archiveDoc`.

import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  IconArchive,
  IconBrandYoutube,
  IconCircleCheck,
  IconCircleDot,
  IconWorld,
  IconPlus,
} from '@tabler/icons-react'
import { useDocsStore, type KnownDoc } from '@/state/docsStore'
import { useActiveSlug } from '@/hooks/useActiveSlug'
import { useSaveArticleDialogStore } from '@/state/saveArticleDialogStore'
import { buildViewUrl } from '@/lib/viewUrl'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'

type Filter = 'unread' | 'read' | 'all'

/** Short, local-timezone date label for the saved-at column. Returns
 * '' for a missing/invalid timestamp so the row just omits the date. */
function savedDateLabel(savedAt?: string): string {
  if (!savedAt) return ''
  const d = new Date(savedAt)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

export function ReadLaterQueue() {
  const knownDocs = useDocsStore((s) => s.knownDocs)
  const activeSlug = useActiveSlug()
  const sidebarTab = useDocsStore((s) => s.sidebarTab)
  const dayAnchor = useDocsStore((s) => s.dayAnchor)
  const monthAnchor = useDocsStore((s) => s.monthAnchor)
  const archiveDoc = useDocsStore((s) => s.archiveDoc)
  const setArticleRead = useDocsStore((s) => s.setArticleRead)
  const openSaveArticle = useSaveArticleDialogStore((s) => s.openDialog)
  const navigate = useNavigate()

  const [filter, setFilter] = useState<Filter>('unread')
  const [query, setQuery] = useState('')

  // Live inbox items (saved articles + captured YouTube), newest first —
  // same predicate the sidebar entry uses.
  const articles = useMemo(
    () =>
      knownDocs
        .filter((d) => d.sourceUrl && !d.archivedAt)
        .sort((a, b) => (b.savedAt ?? '').localeCompare(a.savedAt ?? '')),
    [knownDocs],
  )

  const unreadCount = useMemo(
    () => articles.filter((d) => !d.readAt).length,
    [articles],
  )

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return articles.filter((d) => {
      if (filter === 'unread' && d.readAt) return false
      if (filter === 'read' && !d.readAt) return false
      if (!q) return true
      const hay = `${d.title ?? ''} ${d.siteName ?? ''}`.toLowerCase()
      return hay.includes(q)
    })
  }, [articles, filter, query])

  const openArticle = (slug: string) => {
    navigate(buildViewUrl({ tab: sidebarTab, dayAnchor, monthAnchor, slug }))
  }

  return (
    // pt clears the absolutely-positioned EditorHeader that AppShell
    // overlays on top of this scroll container.
    <div className="mx-auto w-full max-w-3xl px-6 pb-16 pt-[calc(var(--header-h)+8px)]">
      <header className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <h1 className="text-lg font-semibold text-foreground">Inbox</h1>
          {unreadCount > 0 && (
            <span className="text-sm text-muted-foreground">
              {unreadCount} unread
            </span>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => openSaveArticle()}
          aria-label="Add a URL to Inbox"
        >
          <IconPlus className="size-4" />
          Save
        </Button>
      </header>

      <div className="mb-3 flex items-center justify-between gap-3">
        <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)}>
          <TabsList>
            <TabsTrigger value="unread">Unread</TabsTrigger>
            <TabsTrigger value="read">Read</TabsTrigger>
            <TabsTrigger value="all">All</TabsTrigger>
          </TabsList>
        </Tabs>
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search"
          className="h-8 max-w-56"
        />
      </div>

      {visible.length === 0 ? (
        <p className="px-1 py-10 text-center text-sm text-muted-foreground">
          {articles.length === 0
            ? 'Your inbox is empty. Add a URL (article or YouTube) to capture it.'
            : 'Nothing here for this filter.'}
        </p>
      ) : (
        <ul className="flex flex-col">
          {visible.map((doc) => (
            <QueueRow
              key={doc.slug}
              doc={doc}
              isActive={doc.slug === activeSlug}
              onSelect={() => openArticle(doc.slug)}
              onToggleRead={() => setArticleRead(doc.slug, !doc.readAt)}
              onArchive={() => archiveDoc(doc.slug)}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

function QueueRow({
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
  const date = savedDateLabel(doc.savedAt)
  const meta = [doc.siteName, date].filter(Boolean).join(' · ')

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <li>
          <button
            type="button"
            onClick={onSelect}
            className={cn(
              'flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left transition-colors hover:bg-accent',
              isActive && 'bg-selected text-selected-foreground',
              isRead && 'opacity-55',
            )}
            title={doc.siteName ? `${title} — ${doc.siteName}` : title}
          >
            {doc.videoId ? (
              <IconBrandYoutube className="size-5 shrink-0 text-red-500" />
            ) : doc.faviconUrl ? (
              <img
                src={doc.faviconUrl}
                alt=""
                className="size-5 shrink-0 rounded-sm"
                onError={(e) => {
                  e.currentTarget.style.visibility = 'hidden'
                }}
              />
            ) : (
              <IconWorld className="size-5 shrink-0 text-muted-foreground" />
            )}
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm font-medium text-foreground">
                {title}
              </span>
              {meta && (
                <span className="truncate text-xs text-muted-foreground">
                  {meta}
                </span>
              )}
            </span>
            {!isRead && (
              <span
                className="size-1.5 shrink-0 rounded-full bg-primary"
                aria-label="Unread"
              />
            )}
          </button>
        </li>
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
