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
//   • right-click    → context menu (Archive note, optional Move to…)
//
// Built on the TreeRow primitive (`components/ui/tree-row.tsx`):
// chevron / file-icon, label, and + sit as flex siblings inside a
// single <li>, so the row's hover/active background fills naturally
// and there's no absolute-overlay positioning math that breaks when
// the <li> grows to contain expanded children. The chevron is
// wrapped in CollapsibleTrigger asChild and stops click propagation
// so its toggle doesn't also fire the label's select.
//
// Archive lives in the right-click context menu (destructive action
// shouldn't compete visually with create); Move to… is included only
// when the caller passes targets (wiki tree currently does, daily /
// writing don't).

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
  TreeRow,
  TreeRowLabel,
  TreeRowLead,
  TreeRowTrail,
  TreeSub,
} from '@/components/ui/tree-row'
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
  // Writings nest only 1-deep under a daily (Karpathy wiki pattern:
  // flat-on-disk + [[link]] connections rather than folder depth).
  // The "+ add child" affordance is therefore daily-only — surfacing
  // it on writing rows would invite a state the store refuses to
  // create.
  const canAddChild = doc.type === 'daily'

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
          <li
            ref={setNodeRef}
            className={cn('group/menu-item relative', dropIndicatorClass)}
            {...(draggable ? dragSource.listeners : {})}
            {...(draggable ? dragSource.attributes : {})}
          >
            <TreeRow active={isActive}>
              <TreeRowLead asChild>
                <span aria-hidden>
                  <IconFileDescription size={16} stroke={1.75} />
                </span>
              </TreeRowLead>
              <TreeRowLabel onClick={() => onSelect(doc.slug)}>
                <span className="truncate">{label}</span>
              </TreeRowLabel>
              {canAddChild && (
                <TreeRowTrail
                  showOnHover
                  aria-label="Add note"
                  onClick={(e: MouseEvent) => {
                    e.stopPropagation()
                    onAddChild(doc.slug)
                    if (!isExpanded) toggleExpanded(doc.slug)
                  }}
                >
                  <IconPlus stroke={2} />
                </TreeRowTrail>
              )}
            </TreeRow>
          </li>
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
          <li
            ref={setNodeRef}
            className={cn('group/menu-item relative', dropIndicatorClass)}
            {...(draggable ? dragSource.listeners : {})}
            {...(draggable ? dragSource.attributes : {})}
          >
            <TreeRow active={isActive}>
              <CollapsibleTrigger asChild>
                <TreeRowLead
                  aria-label={isExpanded ? 'Collapse' : 'Expand'}
                  onClick={(e: MouseEvent) => e.stopPropagation()}
                >
                  <IconChevronRight
                    size={16}
                    stroke={1.75}
                    className="transition-transform"
                    style={{ transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
                  />
                </TreeRowLead>
              </CollapsibleTrigger>
              <TreeRowLabel onClick={() => onSelect(doc.slug)}>
                <span className="truncate">{label}</span>
              </TreeRowLabel>
              {canAddChild && (
                <TreeRowTrail
                  showOnHover
                  aria-label="Add note"
                  onClick={(e: MouseEvent) => {
                    e.stopPropagation()
                    onAddChild(doc.slug)
                    if (!isExpanded) toggleExpanded(doc.slug)
                  }}
                >
                  <IconPlus stroke={2} />
                </TreeRowTrail>
              )}
            </TreeRow>
            <CollapsibleContent asChild>
              <TreeSub>
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
              </TreeSub>
            </CollapsibleContent>
          </li>
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
