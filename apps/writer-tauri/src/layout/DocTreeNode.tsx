// Recursive sidebar row for a single writing-type doc plus its
// subtree. Pulled out of DocList so DayView can reuse it as the
// today-tree; the structure is identical, only the parent context
// differs (a daily date row vs. a tab container).
//
// The node renders its own row (chevron / icon + label + add button)
// and recurses into children when expanded. Expansion state lives in
// docsStore.expandedDocSlugs so fold/unfold survives reload, bound to
// Radix Collapsible via controlled open/onOpenChange.
//
// Click contract (mirrors Cursor's file tree):
//   • chevron click  → toggle expand only (no selection change)
//   • label click    → open the doc only (no expand toggle)
//   • + click        → create a child note (auto-expands parent)
//   • right-click    → context menu (Archive note)
//
// The chevron is wrapped in CollapsibleTrigger so its click drives
// Radix's open state directly; stopPropagation prevents bubbling to
// the SidebarMenuButton's onClick. The chevron is absolutely
// positioned over the SidebarMenuButton's left padding so the row's
// hover/active background still bleeds wall-to-wall behind it; using
// a fixed `top-2` (not `top: 50%`) keeps it glued to the parent row
// even when the row's <li> grows to contain the expanded subtree.
//
// Archive moved off-row into the right-click context menu (the
// destructive action shouldn't compete visually with create) — this
// also lets the row carry shadcn's intended single-action layout, so
// SidebarMenuButton's auto pr-8 pads exactly the room one action
// needs and we don't fight the primitive's :has() rule with !pr-15.

import { type MouseEvent } from 'react'
import {
  IconArchive,
  IconChevronRight,
  IconFileDescription,
  IconPlus,
} from '@tabler/icons-react'
import { useDraggable, useDroppable } from '@dnd-kit/core'
import { cn } from '@/lib/utils'
import { useDocsStore, type KnownDoc } from '@/state/docsStore'
import { useDocLabel } from '@/hooks/useDocLabel'
import {
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
} from '@/components/ui/sidebar'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'

/** One entry in the "Move to…" section of the context menu. `slug`
 * is the new parent's slug (or `null` to move to root). `label` is
 * what the menu item shows. The caller decides which entries to
 * include so different sidebar regions (daily / writing / wiki)
 * can supply different sets — wiki uses top-level wiki pages,
 * daily / writing currently supply nothing (the prop is omitted
 * and the Move section is skipped entirely). */
export interface MoveTarget {
  slug: string | null
  label: string
  /** Disable the row — used by the caller to grey out the target
   * the doc already lives under, plus any cycle-creating choices. */
  disabled?: boolean
}

interface DocTreeNodeProps {
  doc: KnownDoc
  /** Map from parent slug → direct children, indexed by the caller
   * once per render so each node lookup is O(1). */
  childrenByParent: Map<string, KnownDoc[]>
  activeSlug: string | null
  onSelect: (slug: string) => void
  onAddChild: (parentSlug: string) => void
  onArchive: (slug: string) => void
  /** Optional "Move to…" section in the context menu. Omitted for
   * tree regions where moving doesn't apply (e.g. daily / writing
   * placement is time-axis-driven). */
  moveTargets?: MoveTarget[]
  onMoveTo?: (slug: string, newParentId: string | null) => void
  /** Enable drag-and-drop on this row. Caller is responsible for
   * wrapping the tree in a <DndContext> and resolving the resulting
   * onDragEnd via moveDoc — DocTreeNode just exposes itself as a
   * drag source + drop target. When false (the default), the dnd-kit
   * hooks below still mount but in a disabled state so no listeners
   * attach and no drop interactions fire. */
  draggable?: boolean
}

export function DocTreeNode({
  doc,
  childrenByParent,
  activeSlug,
  onSelect,
  onAddChild,
  onArchive,
  moveTargets,
  onMoveTo,
  draggable = false,
}: DocTreeNodeProps) {
  const label = useDocLabel(doc.slug)
  const expandedDocSlugs = useDocsStore((s) => s.expandedDocSlugs)
  const toggleExpanded = useDocsStore((s) => s.toggleExpanded)
  const children = childrenByParent.get(doc.slug) ?? []
  const hasChildren = children.length > 0
  const isExpanded = expandedDocSlugs.includes(doc.slug)
  const isActive = doc.slug === activeSlug

  // dnd-kit hooks must be called unconditionally to satisfy the
  // Rules of Hooks. When draggable=false the `disabled` option
  // keeps them inert — no listeners attach, no drop hover state
  // fires — so daily / writing trees mount cleanly without a
  // DndContext ancestor.
  const dragSource = useDraggable({ id: doc.slug, disabled: !draggable })
  const dropTarget = useDroppable({ id: doc.slug, disabled: !draggable })
  const setNodeRef = (node: HTMLElement | null) => {
    dragSource.setNodeRef(node)
    dropTarget.setNodeRef(node)
  }
  // Hover ring: when a drag is over this row, show a subtle outline
  // so the user knows where the drop will land. dnd-kit only flips
  // isOver when this exact row is the closest valid drop target.
  const dropIndicatorClass =
    draggable && dropTarget.isOver
      ? 'ring-1 ring-sidebar-accent-foreground/40 rounded-md'
      : ''

  const labelButton = (
    <SidebarMenuButton
      isActive={isActive}
      onClick={() => onSelect(doc.slug)}
      className="pl-8"
    >
      <span>{label}</span>
    </SidebarMenuButton>
  )

  // The + glyph reads as a quiet inline icon (no chunky button chrome)
  // so it sits at the same visual weight as WeekView's right-side
  // count text. Default 16px sizing comes from SidebarMenuAction's
  // [&>svg]:size-4 rule. top-1.5! restores true vertical centering:
  // the cva base correctly uses top-1.5 (centers a 20px action in a
  // 32px row) but peer-data-[size=default]:top-2 pushes it 2px down.
  const addAction = (
    <SidebarMenuAction
      showOnHover
      aria-label="Add note"
      onClick={(e: MouseEvent) => {
        e.stopPropagation()
        onAddChild(doc.slug)
        if (!isExpanded) toggleExpanded(doc.slug)
      }}
      className="top-1.5! text-sidebar-foreground/60 hover:bg-transparent hover:text-sidebar-accent-foreground"
    >
      <IconPlus stroke={2} />
    </SidebarMenuAction>
  )

  // Move section is rendered only when the caller provides
  // targets — keeps daily / writing rows free of an irrelevant
  // "Move to…" block. Each target item self-disables when it's
  // the doc's current parent (or another non-movable choice the
  // caller flagged), so the user can see the option but not act
  // on it redundantly.
  const showMoveSection = !!(moveTargets && moveTargets.length > 0 && onMoveTo)
  // Filter out the doc's current parent (already there) and the
  // doc itself (self-parent) from the rendered options. The
  // store's moveDoc would refuse these anyway, but disabling at
  // render time keeps the menu honest about which options are
  // actionable. Cycle prevention is handled by the caller (it
  // only passes top-level pages, which can't be descendants of a
  // user-owned wiki child) and by moveDoc as the last gate.
  const currentParentSlug = doc.parentId ?? null
  const contextMenu = (
    <ContextMenuContent>
      {showMoveSection &&
        moveTargets!.map((t) => {
          const isCurrent = t.slug === currentParentSlug
          const isSelf = t.slug === doc.slug
          return (
            <ContextMenuItem
              key={t.slug ?? '__root__'}
              disabled={isCurrent || isSelf || t.disabled}
              onSelect={() => onMoveTo!(doc.slug, t.slug)}
            >
              {`Move to ${t.label}`}
            </ContextMenuItem>
          )
        })}
      {showMoveSection && <ContextMenuSeparator />}
      <ContextMenuItem
        variant="destructive"
        onSelect={() => onArchive(doc.slug)}
      >
        <IconArchive stroke={1.75} />
        Archive note
      </ContextMenuItem>
    </ContextMenuContent>
  )

  if (!hasChildren) {
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <SidebarMenuItem
            ref={setNodeRef}
            className={dropIndicatorClass}
            {...(draggable ? dragSource.listeners : {})}
            {...(draggable ? dragSource.attributes : {})}
          >
            <span
              aria-hidden
              className="absolute top-2 left-2 z-10 flex h-4 w-4 items-center justify-center text-sidebar-foreground/60"
            >
              <IconFileDescription size={16} stroke={1.75} />
            </span>
            {labelButton}
            {addAction}
          </SidebarMenuItem>
        </ContextMenuTrigger>
        {contextMenu}
      </ContextMenu>
    )
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <Collapsible
          asChild
          open={isExpanded}
          onOpenChange={(open) => {
            if (open !== isExpanded) toggleExpanded(doc.slug)
          }}
        >
          <SidebarMenuItem
            ref={setNodeRef}
            className={dropIndicatorClass}
            {...(draggable ? dragSource.listeners : {})}
            {...(draggable ? dragSource.attributes : {})}
          >
            <CollapsibleTrigger asChild>
              <button
                type="button"
                aria-label={isExpanded ? 'Collapse' : 'Expand'}
                onClick={(e: MouseEvent) => e.stopPropagation()}
                className={cn(
                  'absolute top-2 left-2 z-10 flex h-4 w-4 items-center justify-center rounded-sm',
                  'text-sidebar-foreground/60 hover:text-sidebar-accent-foreground',
                  'outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/40',
                )}
              >
                <IconChevronRight
                  size={16}
                  stroke={1.75}
                  className="transition-transform"
                  style={{ transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
                />
              </button>
            </CollapsibleTrigger>

            {labelButton}
            {addAction}

            <CollapsibleContent asChild>
              <SidebarMenuSub className="mr-0 pr-0">
                {children.map((child) => (
                  <DocTreeNode
                    key={child.slug}
                    doc={child}
                    childrenByParent={childrenByParent}
                    activeSlug={activeSlug}
                    onSelect={onSelect}
                    onAddChild={onAddChild}
                    onArchive={onArchive}
                    moveTargets={moveTargets}
                    onMoveTo={onMoveTo}
                    draggable={draggable}
                  />
                ))}
              </SidebarMenuSub>
            </CollapsibleContent>
          </SidebarMenuItem>
        </Collapsible>
      </ContextMenuTrigger>
      {contextMenu}
    </ContextMenu>
  )
}

/** Group writing-type docs by parentId so each tree node can fetch
 * its direct children in O(1). Children are sorted by slug for
 * stable ordering until drag-to-reorder ships. */
export function indexChildren(knownDocs: KnownDoc[]): Map<string, KnownDoc[]> {
  const out = new Map<string, KnownDoc[]>()
  for (const d of knownDocs) {
    if (!d.parentId) continue
    const list = out.get(d.parentId)
    if (list) list.push(d)
    else out.set(d.parentId, [d])
  }
  for (const list of out.values()) list.sort((a, b) => a.slug.localeCompare(b.slug))
  return out
}
