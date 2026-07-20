// Universal palette triggered by ⌘K. All vault notes + templates are
// rendered as items and cmdk's built-in fuzzy filter does the ranking
// (matching each item's `value` + `keywords`), plus a small Actions group
// (capture a URL, open Inbox, rename the active note).
//
// The earlier date provider / ⌘G "jump to date" mode was removed with
// the flat-vault change: there are no daily docs to jump to, and the
// date-select path used to recreate a daily on disk.
//
// Empty query → recent docs, ordered by session recency (recentDocsStore).

import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  IconBookmarkPlus,
  IconBookmarks,
  IconEdit,
  IconFileDescription,
  IconFilePlus,
  IconFolderOpen,
  IconSettings,
} from '@tabler/icons-react'
import { defaultFilter } from 'cmdk'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { useDocsStore } from '@/state/docsStore'
import { useRecentDocsStore } from '@/state/recentDocsStore'
import { useActiveSlug } from '@/hooks/useActiveSlug'
import { useSaveArticleDialogStore } from '@/state/saveArticleDialogStore'
import { useCommandPaletteStore } from '@/state/commandPaletteStore'
import { openSettings } from '@/settings/useSettingsDialog'
import { focusLauncher } from '@/lib/projectWindow'
import { openDoc } from '@/lib/openDoc'
import { loadTemplates, type Template } from '@/lib/templates'
import { pathForDoc } from '@/lib/docPaths'
import { docLabel } from '@/hooks/useDocLabel'

// cmdk scores the query against each item's `value` PLUS its `keywords`. Our
// doc items use the opaque slug as `value` (a stable unique id cmdk requires;
// see below), so scoring on `value` would surface notes by random slug text.
// Match on `keywords` when an item provides them (docs carry label/filename/
// folder; templates carry their own) so the slug never pollutes results, and
// fall back to `value` for items that keep their search text there (the
// Actions group).
const paletteFilter = (value: string, search: string, keywords?: string[]) =>
  defaultFilter(keywords?.length ? keywords.join(' ') : value, search)

export function CommandPalette() {
  // Open lives in a store so the sidebar search button can drive the
  // same palette the ⌘K shortcut opens. Query stays local.
  const open = useCommandPaletteStore((s) => s.open)
  const setOpen = useCommandPaletteStore((s) => s.setOpen)
  const openPalette = useCommandPaletteStore((s) => s.openPalette)
  const [query, setQuery] = useState('')

  // Reset the query each time the palette opens (from any trigger).
  useEffect(() => {
    if (open) setQuery('')
  }, [open])

  const knownDocs = useDocsStore((s) => s.knownDocs)
  const recentOrder = useRecentDocsStore((s) => s.order)
  const activeSlug = useActiveSlug()
  const renameDoc = useDocsStore((s) => s.renameDoc)
  const createFromTemplate = useDocsStore((s) => s.createFromTemplate)
  const openSaveArticle = useSaveArticleDialogStore((s) => s.openDialog)
  const navigate = useNavigate()

  // Vault templates, loaded each time the palette opens (they're `.md` files
  // the user can add/edit anytime). Empty when there's no `templates/` folder.
  const [templates, setTemplates] = useState<Template[]>([])
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void loadTemplates().then((t) => {
      if (!cancelled) setTemplates(t)
    })
    return () => {
      cancelled = true
    }
  }, [open])

  // Renameable active doc — generic notes, writing notes, AND
  // user-owned wiki pages. System pages (fixed names) and dailies
  // (date-derived) refused by renameDoc anyway, but filter here so
  // they don't appear in the Actions group at all.
  const renameableDoc = useMemo(() => {
    if (!activeSlug) return null
    const d = knownDocs.find((x) => x.slug === activeSlug)
    if (!d) return null
    if (
      d.type !== 'note' &&
      d.type !== 'writing' &&
      !d.type.startsWith('wiki:custom-')
    )
      return null
    return d
  }, [knownDocs, activeSlug])

  // Global shortcut. ⌘K opens the palette.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.shiftKey || e.altKey) return
      if (e.key === 'k' || e.key === 'K') {
        e.preventDefault()
        openPalette()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [openPalette])

  // Exclude archived docs and `system:*` surfaces (_system/index.md,
  // log.md): the latter are agent-owned, read-only, and have their own
  // surfaces — they're not valid navigation targets, mirroring the
  // wikilink palette / autocomplete filters. Without this they'd leak
  // into search + recents and, once opened, persist as a tab.
  const liveDocs = useMemo(
    () =>
      knownDocs.filter(
        (d) => !d.type.startsWith('system:'),
      ),
    [knownDocs],
  )

  // Per-doc display + search metadata. cmdk's built-in filter ranks items
  // by fuzzy-matching the query against each item's `value` + `keywords`,
  // so we feed it label, filename and folder path (tags don't exist on
  // KnownDoc). `folder` also renders as a subtext line to disambiguate
  // same-named notes. Path comes from the one canonical mapping,
  // `pathForDoc`; `label` from the shared doc-label policy.
  const docMeta = useMemo(() => {
    const getDoc = (s: string) => knownDocs.find((d) => d.slug === s)
    const map = new Map<string, { label: string; folder: string; keywords: string[] }>()
    for (const doc of liveDocs) {
      const label = docLabel(doc)
      const path = pathForDoc(doc, getDoc) ?? doc.relPath ?? ''
      const filename = path.split('/').pop() ?? ''
      const folder = path.slice(0, path.length - filename.length).replace(/\/$/, '')
      map.set(doc.slug, {
        label,
        folder,
        keywords: [label, filename, folder].filter((s) => s.length > 0),
      })
    }
    return map
  }, [liveDocs, knownDocs])

  // Empty-query "Recent" ordering: sort by session recency (most-recent
  // first, then the rest in knownDocs order), capped so the empty palette
  // stays tidy rather than dumping the whole vault. With a query present,
  // cmdk re-sorts by match score and every doc must stay reachable, so we
  // hand it the full list unsorted (DOM order there is irrelevant).
  const orderedDocs = useMemo(() => {
    if (query.trim()) return liveDocs
    const rank = new Map(recentOrder.map((slug, i) => [slug, i]))
    const seen = (slug: string) => rank.get(slug) ?? Number.POSITIVE_INFINITY
    return [...liveDocs].sort((a, b) => seen(a.slug) - seen(b.slug)).slice(0, 50)
  }, [liveDocs, recentOrder, query])

  const onSelectTemplate = (t: Template) => {
    setOpen(false)
    void createFromTemplate(t).then((slug) => {
      openDoc(slug)
    })
  }

  const onSelectDoc = (slug: string) => {
    setOpen(false)
    openDoc(slug)
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      className="command-palette"
      filter={paletteFilter}
    >
      <CommandInput
        placeholder="Search notes…"
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        <CommandEmpty>No matches.</CommandEmpty>
        {/* Actions — always rendered (cmdk filters them by query); Rename
            only appears for a renameable active doc (wiki + writing). */}
        <CommandGroup heading="Actions">
          <CommandItem
            value="action:add-to-inbox add url inbox youtube article"
            onSelect={() => {
              setOpen(false)
              // Defer so the palette's dismiss animation doesn't race
              // the dialog mount (same reason as the rename prompt).
              setTimeout(() => openSaveArticle(), 0)
            }}
          >
            <IconBookmarkPlus size={16} stroke={1.75} />
            <span className="flex-1 truncate">Add URL to Inbox</span>
          </CommandItem>
          <CommandItem
            value="action:open-inbox inbox read later"
            onSelect={() => {
              setOpen(false)
              navigate('/read-later')
            }}
          >
            <IconBookmarks size={16} stroke={1.75} />
            <span className="flex-1 truncate">Open Inbox</span>
          </CommandItem>
          <CommandItem
            value="action:open-project switch project launcher open another vault"
            onSelect={() => {
              setOpen(false)
              void focusLauncher()
            }}
          >
            <IconFolderOpen size={16} stroke={1.75} />
            <span className="flex-1 truncate">Open project…</span>
          </CommandItem>
          <CommandItem
            value="action:open-settings settings preferences theme font"
            onSelect={() => {
              setOpen(false)
              openSettings()
            }}
          >
            <IconSettings size={16} stroke={1.75} />
            <span className="flex-1 truncate">Open Settings</span>
          </CommandItem>
          {renameableDoc && (
            <CommandItem
              value="action:rename-active"
              onSelect={() => {
                setOpen(false)
                // Defer the prompt so the dialog dismiss animation
                // doesn't race the native modal — without this the
                // prompt can appear before the palette has cleared
                // focus, leading to two stacked dialogs on some
                // window managers.
                setTimeout(() => {
                  const input = window.prompt(
                    'Rename note',
                    renameableDoc.title ?? '',
                  )
                  if (input === null) return
                  const trimmed = input.trim()
                  if (trimmed.length === 0) return
                  renameDoc(renameableDoc.slug, trimmed)
                }, 0)
              }}
            >
              <IconEdit size={16} stroke={1.75} />
              <span className="flex-1 truncate">
                Rename “{renameableDoc.title || 'Untitled'}”
              </span>
            </CommandItem>
          )}
        </CommandGroup>
        {templates.length > 0 && (
          <CommandGroup heading="New from template">
            {templates.map((t) => (
              <CommandItem
                key={`tmpl-${t.name}`}
                value={`template:${t.name}`}
                keywords={['template', 'new', t.name]}
                onSelect={() => onSelectTemplate(t)}
              >
                <IconFilePlus size={16} stroke={1.75} />
                <span className="flex-1 truncate">{t.name}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {orderedDocs.length > 0 && (
          <CommandGroup heading={query.trim() ? 'Notes' : 'Recent'}>
            {orderedDocs.map((doc) => {
              const meta = docMeta.get(doc.slug)
              return (
                <CommandItem
                  key={`doc-${doc.slug}`}
                  value={doc.slug}
                  keywords={meta?.keywords}
                  onSelect={() => onSelectDoc(doc.slug)}
                >
                  <IconFileDescription size={16} stroke={1.75} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{meta?.label ?? 'Untitled'}</span>
                    {meta?.folder && (
                      <span className="truncate text-xs text-muted-foreground">
                        {meta.folder}
                      </span>
                    )}
                  </span>
                </CommandItem>
              )
            })}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  )
}
