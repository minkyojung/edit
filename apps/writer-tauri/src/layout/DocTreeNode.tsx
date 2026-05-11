// Recursive sidebar row for a single writing-type doc plus its
// subtree. Pulled out of DocList so DayView can reuse it as the
// today-tree; the structure is identical, only the parent context
// differs (a daily date row vs. a tab container).
//
// The node renders its own row (chevron / icon + label + hover
// actions) and recurses into children when expanded. Expansion
// state lives in docsStore.expandedDocSlugs so fold/unfold survives
// reload.
//
// Click contract (mirrors Cursor's file tree):
//   • chevron click  → toggle expand only (no selection change)
//   • label click    → open the doc only (no expand toggle)
// The chevron is an overlay button positioned over the row's left
// padding, with stopPropagation so its click doesn't bubble to the
// SidebarMenuButton's onClick.

import { type MouseEvent } from 'react'
import {
  IconArchive,
  IconChevronRight,
  IconFileDescription,
  IconPlus,
} from '@tabler/icons-react'
import { cn } from '@/lib/utils'
import { useDocsStore, type KnownDoc } from '@/state/docsStore'
import { useDocLabel } from '@/hooks/useDocLabel'
import {
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'

interface DocTreeNodeProps {
  doc: KnownDoc
  /** Map from parent slug → direct children, indexed by the caller
   * once per render so each node lookup is O(1). */
  childrenByParent: Map<string, KnownDoc[]>
  activeSlug: string | null
  /** Tree depth from the topmost row in the wrapping list. Used to
   * indent the row content while keeping each row full-width so the
   * hover background bleeds wall-to-wall. The vertical guide line is
   * drawn separately in the parent <ul> at `depth*INDENT_PX + LINE_PX`. */
  depth: number
  onSelect: (slug: string) => void
  onAddChild: (parentSlug: string) => void
  onArchive: (slug: string) => void
}

const INDENT_PX = 14
const ROW_BASE_PAD_LEFT = 6
const CHEVRON_GUTTER_PX = 22 // chevron (16) + gap to label (6)

export function DocTreeNode({
  doc,
  childrenByParent,
  activeSlug,
  depth,
  onSelect,
  onAddChild,
  onArchive,
}: DocTreeNodeProps) {
  const label = useDocLabel(doc.slug)
  const expandedDocSlugs = useDocsStore((s) => s.expandedDocSlugs)
  const toggleExpanded = useDocsStore((s) => s.toggleExpanded)
  const children = childrenByParent.get(doc.slug) ?? []
  const hasChildren = children.length > 0
  const isExpanded = expandedDocSlugs.includes(doc.slug)
  const isActive = doc.slug === activeSlug

  const chevronLeftPx = depth * INDENT_PX + ROW_BASE_PAD_LEFT
  const rowPadLeftPx = chevronLeftPx + CHEVRON_GUTTER_PX

  return (
    <SidebarMenuItem>
      {/* Leading: expand toggle (or file glyph). Overlaid over the
          SidebarMenuButton's left padding so the row's hover/active
          background still bleeds wall-to-wall behind it. */}
      {hasChildren ? (
        <button
          type="button"
          onClick={(e: MouseEvent) => {
            e.stopPropagation()
            toggleExpanded(doc.slug)
          }}
          aria-label={isExpanded ? 'Collapse' : 'Expand'}
          className={cn(
            'absolute z-10 flex h-4 w-4 items-center justify-center rounded-sm',
            'text-sidebar-foreground/60 hover:text-sidebar-accent-foreground',
            'outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/40',
          )}
          style={{
            left: `${chevronLeftPx}px`,
            top: '50%',
            transform: 'translateY(-50%)',
          }}
        >
          <IconChevronRight
            size={16}
            stroke={1.75}
            className="transition-transform"
            style={{ transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
          />
        </button>
      ) : (
        <span
          aria-hidden
          className="absolute z-10 flex h-4 w-4 items-center justify-center text-sidebar-foreground/60"
          style={{
            left: `${chevronLeftPx}px`,
            top: '50%',
            transform: 'translateY(-50%)',
          }}
        >
          <IconFileDescription size={16} stroke={1.75} />
        </span>
      )}

      <SidebarMenuButton
        isActive={isActive}
        onClick={() => onSelect(doc.slug)}
        className="pr-14"
        style={{ paddingLeft: `${rowPadLeftPx}px` }}
      >
        <span>{label}</span>
      </SidebarMenuButton>

      <SidebarMenuAction
        showOnHover
        aria-label="Archive note"
        title="Archive"
        onClick={(e: MouseEvent) => {
          e.stopPropagation()
          onArchive(doc.slug)
        }}
        className="right-7 size-5"
      >
        <IconArchive size={10} stroke={1.75} />
      </SidebarMenuAction>

      <SidebarMenuAction
        showOnHover
        aria-label="Add note"
        onClick={(e: MouseEvent) => {
          e.stopPropagation()
          onAddChild(doc.slug)
          if (!isExpanded) toggleExpanded(doc.slug)
        }}
        className="size-5"
      >
        <IconPlus size={10} stroke={2} />
      </SidebarMenuAction>

      {isExpanded && hasChildren && (
        <ul className="flex flex-col gap-0.5 pt-0.5">
          {children.map((child) => (
            <DocTreeNode
              key={child.slug}
              doc={child}
              childrenByParent={childrenByParent}
              activeSlug={activeSlug}
              depth={depth + 1}
              onSelect={onSelect}
              onAddChild={onAddChild}
              onArchive={onArchive}
            />
          ))}
        </ul>
      )}
    </SidebarMenuItem>
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
