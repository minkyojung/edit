// Recursive sidebar row for a single writing-type doc plus its
// subtree. Pulled out of DocList so DayView can reuse it as the
// today-tree; the structure is identical, only the parent context
// differs (a daily date row vs. a tab container).
//
// The node renders its own row (chevron / icon + label + hover
// actions) and recurses into children when expanded. Expansion
// state lives in docsStore.expandedDocSlugs so fold/unfold survives
// reload.

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
const LINE_PX = 8
const ROW_BASE_PAD_LEFT = 6

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

  return (
    <li>
      <div
        className={cn(
          'group flex w-full items-center gap-1 pr-1.5 py-1.5 text-[13px] font-medium transition-colors',
          isActive
            ? 'bg-accent text-foreground'
            : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
        )}
        style={{ paddingLeft: `${depth * INDENT_PX + ROW_BASE_PAD_LEFT}px` }}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={(e: MouseEvent) => {
              e.stopPropagation()
              toggleExpanded(doc.slug)
            }}
            aria-label={isExpanded ? 'Collapse' : 'Expand'}
            className={cn(
              'flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground/70 hover:text-foreground',
              'outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
            )}
          >
            <IconChevronRight
              size={12}
              stroke={1.75}
              className="transition-transform"
              style={{ transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
            />
          </button>
        ) : (
          <span
            className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground"
            aria-hidden
          >
            <IconFileDescription size={12} stroke={1.75} />
          </span>
        )}

        <button
          type="button"
          onClick={() => onSelect(doc.slug)}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-2 text-left outline-none',
            'focus-visible:ring-2 focus-visible:ring-ring/40 rounded',
          )}
        >
          <span className="truncate">{label}</span>
        </button>

        <button
          type="button"
          onClick={(e: MouseEvent) => {
            e.stopPropagation()
            onArchive(doc.slug)
          }}
          aria-label="Archive note"
          title="Archive"
          className={cn(
            'flex h-4 w-4 shrink-0 items-center justify-center rounded',
            'opacity-0 transition-opacity hover:bg-foreground/10 hover:text-foreground',
            'group-hover:opacity-60 focus-visible:opacity-100',
            'outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
          )}
        >
          <IconArchive size={10} stroke={1.75} />
        </button>

        <button
          type="button"
          onClick={(e: MouseEvent) => {
            e.stopPropagation()
            onAddChild(doc.slug)
            if (!isExpanded) toggleExpanded(doc.slug)
          }}
          aria-label="Add note"
          className={cn(
            'flex h-4 w-4 shrink-0 items-center justify-center rounded',
            'opacity-0 transition-opacity hover:bg-foreground/10 hover:text-foreground',
            'group-hover:opacity-60 focus-visible:opacity-100',
            'outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
          )}
        >
          <IconPlus size={10} stroke={2} />
        </button>
      </div>

      {isExpanded && hasChildren && (
        <ul className="relative flex flex-col gap-0.5 pt-0.5">
          {/* Vertical guide line for this node's children. Drawn as an
              absolute span so each child <li> can keep full sidebar
              width and its hover background bleeds wall-to-wall. */}
          <span
            aria-hidden
            className="absolute top-0.5 bottom-0 w-px bg-border"
            style={{ left: `${depth * INDENT_PX + LINE_PX}px` }}
          />
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
    </li>
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
