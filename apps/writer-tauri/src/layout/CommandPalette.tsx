// Universal palette triggered by ⌘K. A single "doc" provider does a
// substring search over the vault's notes, plus a small Actions group
// (capture a URL, open Inbox, rename/archive the active note).
//
// The earlier date provider / ⌘G "jump to date" mode was removed with
// the flat-vault change: there are no daily docs to jump to, and the
// date-select path used to recreate a daily on disk.
//
// Empty query → recent docs (knownDocs order; no per-doc lastAccessed
// yet).

import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  IconArchive,
  IconBookmarkPlus,
  IconBookmarks,
  IconEdit,
  IconFileDescription,
} from '@tabler/icons-react'
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import {
  useDocsStore,
  type KnownDoc,
} from '@/state/docsStore'
import { useActiveSlug } from '@/hooks/useActiveSlug'
import { useSaveArticleDialogStore } from '@/state/saveArticleDialogStore'
import { useCommandPaletteStore } from '@/state/commandPaletteStore'
import { buildViewUrl } from '@/lib/viewUrl'

interface DocResult {
  doc: KnownDoc
}

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
  const activeSlug = useActiveSlug()
  const archiveDoc = useDocsStore((s) => s.archiveDoc)
  const renameDoc = useDocsStore((s) => s.renameDoc)
  const openSaveArticle = useSaveArticleDialogStore((s) => s.openDialog)
  const navigate = useNavigate()

  // Active doc — used by the "Archive current note" action. Only
  // writing-type counts; archiveDoc refuses dailies anyway.
  const activeDoc = useMemo(() => {
    if (!activeSlug) return null
    const d = knownDocs.find((x) => x.slug === activeSlug)
    return d && d.type === 'writing' && !d.archivedAt ? d : null
  }, [knownDocs, activeSlug])

  // Renameable active doc — generic notes, writing notes, AND
  // user-owned wiki pages. System pages (fixed names) and dailies
  // (date-derived) refused by renameDoc anyway, but filter here so
  // they don't appear in the Actions group at all.
  const renameableDoc = useMemo(() => {
    if (!activeSlug) return null
    const d = knownDocs.find((x) => x.slug === activeSlug)
    if (!d || d.archivedAt) return null
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

  const liveDocs = useMemo(
    () => knownDocs.filter((d) => !d.archivedAt),
    [knownDocs],
  )

  // Doc provider — substring match on title/filename. Cheap, no fuse
  // dependency for now.
  const docResults = useMemo<DocResult[]>(() => {
    const q = query.trim().toLowerCase()
    if (!q) {
      // Empty query: show recent activity. We don't have a per-doc
      // lastAccessed yet, so fall back to "recent first" by knownDocs
      // order, capped.
      return liveDocs.slice(0, 8).map((doc) => ({ doc }))
    }
    return liveDocs
      .filter((doc) => (doc.title ?? '').toLowerCase().includes(q))
      .slice(0, 12)
      .map((doc) => ({ doc }))
  }, [liveDocs, query])

  const onSelect = (r: DocResult) => {
    setOpen(false)
    const store = useDocsStore.getState()
    navigate(
      buildViewUrl({
        tab: store.sidebarTab,
        dayAnchor: store.dayAnchor,
        monthAnchor: store.monthAnchor,
        slug: r.doc.slug,
      }),
    )
  }

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      {/* cmdk's built-in filter sorts items by fuzzy match against
          their `value`. We do our own filtering above. */}
      <Command shouldFilter={false}>
      <CommandInput
        placeholder="Search notes…"
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        {/* Actions. "Add URL to Inbox" / "Open Inbox" are always
            available; rename works for wiki + writing; archive only for
            writing. */}
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
          {activeDoc && (
            <CommandItem
              value="action:archive-active"
              onSelect={() => {
                const next = archiveDoc(activeDoc.slug)
                if (next) {
                  const store = useDocsStore.getState()
                  navigate(
                    buildViewUrl({
                      tab: store.sidebarTab,
                      dayAnchor: store.dayAnchor,
                      monthAnchor: store.monthAnchor,
                      slug: next,
                    }),
                  )
                }
                setOpen(false)
              }}
              className="text-destructive data-[selected=true]:text-destructive"
            >
              <IconArchive size={16} stroke={1.75} />
              <span className="flex-1 truncate">
                Archive “{activeDoc.title || 'Untitled'}”
              </span>
            </CommandItem>
          )}
        </CommandGroup>
        {docResults.length > 0 && (
          <CommandGroup heading={query.trim() ? 'Notes' : 'Recent'}>
            {docResults.map((r) => (
              <CommandItem
                key={`doc-${r.doc.slug}`}
                value={`doc:${r.doc.slug}:${r.doc.title || 'Untitled'}`}
                onSelect={() => onSelect(r)}
              >
                <IconFileDescription size={16} stroke={1.75} />
                <span className="flex-1 truncate">
                  {r.doc.title || 'Untitled'}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        <CommandEmpty>No matches.</CommandEmpty>
      </CommandList>
      </Command>
    </CommandDialog>
  )
}
