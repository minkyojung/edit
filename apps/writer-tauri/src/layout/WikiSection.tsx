// Wiki pages section for the sidebar — split into two groups that
// mirror Karpathy's schema-vs-wiki separation:
//
//   System  → agent meta surface (conventions / log / index).
//             Read-only from the user's perspective — the LLM
//             writes / maintains these pages on dedicated prompt
//             channels (not via the wiki catalog), so they get
//             their own visual region with no `+` button. System
//             pages stay flat: they're a small fixed set, no
//             nesting affordance is useful here.
//
//   Wiki    → user-accumulated content pages (`wiki:custom-*`).
//             Rendered as a tree (DocTreeNode) so the user can
//             organise pages under category pages like "Work" or
//             "People" — Anthropic's filesystem-style nesting
//             pattern, not a separate tag / category schema.
//             Created via the group-level `+` button (root page)
//             or the per-row `+` action (child of an existing
//             wiki page).
//
// Lives below the date-axis date view because both groups are
// agent-managed memory, not user-authored notes on the time
// spine; mixing them blurs the write-ownership split (see
// isWikiDoc in docsStore).

import { useMemo } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { IconFileDescription, IconPlus } from '@tabler/icons-react'
import {
  DndContext,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { cn } from '@/lib/utils'
import { useDocsStore, type KnownDoc } from '@/state/docsStore'
import { useDocLabel } from '@/hooks/useDocLabel'
import { createCustomWikiPage } from '@/state/wikiService'
import { notify } from '@/lib/notify'
import { DocTreeNode, indexChildren, type MoveTarget } from './DocTreeNode'
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'

/** dnd-kit identifier for the "promote to root" drop target. Real
 * wiki slugs are uuids so any non-uuid sentinel works; this string
 * lives next to its only consumer (the drop handler below) so a
 * future rename stays local. */
const ROOT_DROP_ID = 'wiki:__root__'

export function WikiSection() {
  const knownDocs = useDocsStore((s) => s.knownDocs)
  const activeSlug = useDocsStore((s) => s.activeSlug)
  const setActive = useDocsStore((s) => s.setActive)
  const archiveDoc = useDocsStore((s) => s.archiveDoc)
  const moveDoc = useDocsStore((s) => s.moveDoc)
  const navigate = useNavigate()
  const { pathname } = useLocation()

  const systemDocs = useMemo(
    () =>
      knownDocs.filter((d) => !d.archivedAt && d.type.startsWith('system:')),
    [knownDocs],
  )
  // Live wiki pages — the universe DocTreeNode walks. childrenByParent
  // is keyed across this whole set, so a node at any depth gets its
  // direct children in O(1).
  const wikiDocs = useMemo(
    () => knownDocs.filter((d) => !d.archivedAt && d.type.startsWith('wiki:')),
    [knownDocs],
  )
  const childrenByParent = useMemo(
    () => indexChildren(wikiDocs),
    [wikiDocs],
  )
  // Only roots render at the top level — descendants come in via
  // DocTreeNode's recursion. Filtering by `!parentId` keeps a child
  // from being drawn twice when its parent is also live.
  const rootWikiDocs = useMemo(
    () => wikiDocs.filter((d) => !d.parentId),
    [wikiDocs],
  )
  // Move-to targets surfaced in each row's context menu: the
  // top-level wiki pages (which act as categories) plus a Root
  // option for promoting a nested page back up. Top-level only
  // means cycle prevention is trivial — a root page can't be a
  // descendant of any moved doc — and matches Phase 2's "pick a
  // category by title" mental model. Deeper-tree moves are the
  // drag-and-drop surface's job (Phase 3-3+).
  const moveTargets = useMemo<MoveTarget[]>(() => {
    const targets: MoveTarget[] = [{ slug: null, label: '(Root)' }]
    for (const d of rootWikiDocs) {
      const title = (d.title ?? '').trim() || d.type.replace(/^wiki:custom-/, '')
      targets.push({ slug: d.slug, label: title })
    }
    return targets
  }, [rootWikiDocs])
  const handleMoveTo = (slug: string, newParentId: string | null) => {
    moveDoc(slug, newParentId)
  }

  // Pointer sensor with a small activation distance so the row's
  // single-click "open this doc" gesture isn't accidentally read
  // as the start of a drag. 8px is the dnd-kit default reference;
  // it survives a quick mouseup before the drag overlay engages.
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
  )

  // Drop handler. dnd-kit routes the source's `id` and the over
  // target's `id` here; we translate ROOT_DROP_ID to a null parent,
  // then defer all validation (cycle, system parent, archived) to
  // moveDoc. A false return surfaces the refusal toast — context-
  // menu items self-disable so they don't reach this path.
  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over) return
    const sourceSlug = String(active.id)
    const newParentId = over.id === ROOT_DROP_ID ? null : String(over.id)
    const ok = moveDoc(sourceSlug, newParentId)
    if (!ok) notify.cantMoveDoc()
  }

  const ensureNotesRoute = () => {
    if (!pathname.startsWith('/notes')) navigate('/notes')
  }

  const handleNewRoot = async () => {
    // Root creation: no parent. User then either types a title in
    // place or renames in their own time. Notion-style — empty title
    // IS the prompt; useDocLabel falls back to 'Untitled' in the
    // sidebar until something real is typed.
    const slug = await createCustomWikiPage('')
    if (!slug) return
    setActive(slug)
    ensureNotesRoute()
  }

  const handleNewChild = async (parentSlug: string) => {
    // Child creation through the per-row `+` action. createCustomWiki
    // Page validates the parent (must be a live wiki:custom-*) so a
    // stale slug degrades to root rather than failing.
    const slug = await createCustomWikiPage('', undefined, { parentId: parentSlug })
    if (!slug) return
    setActive(slug)
    ensureNotesRoute()
  }

  const onSelectDoc = (slug: string) => {
    setActive(slug)
    ensureNotesRoute()
  }
  const onArchiveDoc = (slug: string) => {
    archiveDoc(slug)
  }

  // System rows are intentionally simple: no nesting, no add button,
  // no archive (those are agent-managed). Keep them as plain rows so
  // they read as a meta region rather than a peer of the content
  // tree below.
  const renderSystemRow = (doc: KnownDoc) => (
    <SidebarMenuItem key={doc.slug} data-slug={doc.slug}>
      <SystemRow
        doc={doc}
        isActive={doc.slug === activeSlug}
        onSelect={() => onSelectDoc(doc.slug)}
      />
    </SidebarMenuItem>
  )

  return (
    <>
      {systemDocs.length > 0 && (
        <SidebarGroup>
          <SidebarGroupLabel>System</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>{systemDocs.map(renderSystemRow)}</SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      )}
      <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
        <SidebarGroup>
          <SidebarGroupLabel>Wiki</SidebarGroupLabel>
          <SidebarGroupAction onClick={handleNewRoot} aria-label="New wiki page">
            <IconPlus />
          </SidebarGroupAction>
          <SidebarGroupContent>
            <SidebarMenu>
              {rootWikiDocs.map((doc) => (
                <DocTreeNode
                  key={doc.slug}
                  doc={doc}
                  childrenByParent={childrenByParent}
                  activeSlug={activeSlug}
                  onSelect={onSelectDoc}
                  onAddChild={handleNewChild}
                  onArchive={onArchiveDoc}
                  moveTargets={moveTargets}
                  onMoveTo={handleMoveTo}
                  draggable
                />
              ))}
              <RootDropZone />
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </DndContext>
    </>
  )
}

/** Tail-of-list drop target that promotes a dragged doc to the
 * root by setting parentId = null. Rendered as a thin spacer below
 * the last wiki row — large enough to land a drag on without
 * stealing visual real estate from real content. dnd-kit's isOver
 * paints a subtle highlight so the user sees what the drop will
 * mean. */
function RootDropZone() {
  const { isOver, setNodeRef } = useDroppable({ id: ROOT_DROP_ID })
  return (
    <li
      ref={setNodeRef}
      data-slot="wiki-root-drop"
      aria-label="Drop here to move to top level"
      className={cn(
        'mx-2 my-1 h-6 rounded-md border border-dashed border-transparent',
        'transition-colors',
        isOver && 'border-sidebar-accent-foreground/50 bg-sidebar-accent/20',
      )}
    />
  )
}

function SystemRow({
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
