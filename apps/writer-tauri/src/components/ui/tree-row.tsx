// TreeRow — sidebar tree row primitive built specifically for our
// recursive note tree (DocTreeNode + WeekView's DayItem). Composes as
// <TreeRow><Lead/><Label/><Trail/></TreeRow> so chevron / label /
// action sit as flex siblings — no absolute overlays, no nested-
// button hacks, no fight against shadcn's flat-menu cva rules
// (auto-pr-8 :has cascade, conditional top values for icon-aligned
// actions, etc). Visual tokens (color / hover / active / radius /
// focus ring) mirror SidebarMenuButton exactly so swapping in is
// pixel-equivalent. See `.context/tree-row-tokens.md` for the full
// token spec.
//
// Why this exists: the shadcn sidebar primitives assume a flat menu
// with one button + maybe one absolute action per row. Our tree
// recurses (menu-item nests menu-item with its own actions inside
// SidebarMenuSub), which makes shadcn's `:has(menu-action)` rules
// cascade across tree boundaries and forces overlay positioning for
// the leading slot when the click contract requires separate
// chevron / label triggers (HTML doesn't allow nested <button>).
// The accumulated workarounds (top-1.5!, pr-15!, pr-3!, absolute
// chevron) are symptoms of that mismatch — TreeRow sidesteps it by
// composing lower-level Tailwind directly with the same color tokens.

import * as React from 'react'
import { Slot } from 'radix-ui'
import { cn } from '@/lib/utils'

interface TreeRowProps extends React.ComponentProps<'div'> {
  /** Whether this row is the currently selected doc. Drives the
   * `data-active` attribute which, combined with the cn-merged
   * `data-active:bg-sidebar-accent` rule, paints the row in the
   * accent palette — matching `SidebarMenuButton`'s isActive look. */
  active?: boolean
}

/**
 * The row itself — a <div> with flex layout for Lead / Label / Trail.
 * Intentionally NOT the outer <li>: the caller wraps TreeRow in their
 * own <li> alongside any sibling content (CollapsibleContent + child
 * <ul>, etc.) that should stack vertically below the row. Making
 * TreeRow the <li> would force every sibling into the same flex line
 * and break tree expansion.
 *
 * Carries the row-level styling (height, hover bg, active bg, base
 * text color) that all child slots inherit via `text-inherit`.
 *
 * The `group/tree-row` named group lets Trail's `showOnHover` track
 * the row's hover/focus-within state without colliding with shadcn's
 * `group/menu-item` (used by SidebarMenuAction's peer rules).
 */
function TreeRow({ active, className, ...props }: TreeRowProps) {
  return (
    <div
      data-slot="tree-row"
      data-active={active || undefined}
      className={cn(
        'group/tree-row relative flex h-8 w-full items-center rounded-xl',
        'text-sm font-medium text-sidebar-foreground/60',
        'transition-colors duration-150',
        'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
        'data-active:bg-sidebar-accent data-active:text-sidebar-accent-foreground',
        className,
      )}
      {...props}
    />
  )
}

/**
 * Leading slot at the row's start — chevron for branches, file glyph
 * for leaves. Defaults to <button> for clickable chevrons; pass
 * `asChild` with a <span aria-hidden> child for non-interactive
 * leaves so the slot doesn't grab focus or fire a click for a static
 * icon. The 16×16 box matches SidebarMenuButton's `[&_svg]:size-4`
 * spec so icons line up across rows regardless of button vs. span.
 */
function TreeRowLead({
  asChild = false,
  className,
  ...props
}: React.ComponentProps<'button'> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'button'
  return (
    <Comp
      data-slot="tree-row-lead"
      {...(!asChild && { type: 'button' as const })}
      className={cn(
        'ml-2 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm',
        'text-inherit',
        'outline-hidden focus-visible:ring-2 focus-visible:ring-sidebar-ring/40',
        '[&_svg]:size-4 [&_svg]:shrink-0',
        className,
      )}
      {...props}
    />
  )
}

/**
 * The doc-title button. Flex container so children can compose freely
 * (single label with truncate, or label + right-aligned trailing
 * content like a count badge). h-full makes the entire row's middle
 * clickable, not just the text height — matches SidebarMenuButton's
 * "click anywhere on the row" feel.
 *
 * Caller is responsible for truncation: pass `<span className="truncate">
 * {label}</span>` for the simple case so the ellipsis honors the
 * row's available width. The button itself is `min-w-0 overflow-hidden`
 * which is what lets the inner truncate work in a flex context.
 */
function TreeRowLabel({
  className,
  ...props
}: React.ComponentProps<'button'>) {
  return (
    <button
      type="button"
      data-slot="tree-row-label"
      className={cn(
        'mx-2 flex h-full min-w-0 flex-1 items-center gap-2 overflow-hidden',
        'text-left text-inherit',
        'outline-hidden focus-visible:ring-2 focus-visible:ring-sidebar-ring/40',
        className,
      )}
      {...props}
    />
  )
}

/**
 * Trailing action button (e.g. "+"). Optional `showOnHover` makes it
 * appear only when the row is hovered or focus-within — matching
 * SidebarMenuAction's `showOnHover` discoverability without its
 * absolute positioning + peer-data top quirks.
 */
function TreeRowTrail({
  asChild = false,
  showOnHover = false,
  className,
  ...props
}: React.ComponentProps<'button'> & {
  asChild?: boolean
  showOnHover?: boolean
}) {
  const Comp = asChild ? Slot.Root : 'button'
  return (
    <Comp
      data-slot="tree-row-trail"
      {...(!asChild && { type: 'button' as const })}
      className={cn(
        'mr-1 flex aspect-square w-5 shrink-0 items-center justify-center rounded-xl',
        'text-inherit transition-opacity',
        'outline-hidden focus-visible:ring-2 focus-visible:ring-sidebar-ring/40',
        '[&>svg]:size-4 [&>svg]:shrink-0',
        showOnHover &&
          'opacity-0 group-hover/tree-row:opacity-100 group-focus-within/tree-row:opacity-100',
        className,
      )}
      {...props}
    />
  )
}

export { TreeRow, TreeRowLead, TreeRowLabel, TreeRowTrail }
