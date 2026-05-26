// Sidebar dot indicator — replaces the per-doc file icon in the
// sidebar tree. The dot is the user's only signal that an AI
// surface has staged a change on that page.
//
// Visual states:
//   - default: a faint round dot that reads as "just a list-item
//     bullet", same footprint as the previous IconFileDescription so
//     row alignment stays put.
//   - pending: same dot in `bg-info` (the app's accent blue, the
//     same tint the Chat capsule and other "AI-attention" affordances
//     use). Subtle but discoverable while the user is browsing.
//
// Subscribes to `usePendingChangesStore`. Re-renders are cheap — the
// selector returns a Set and the `has(slug)` check is the entire
// equality contract; React only re-renders rows whose state flipped.
//
// No click handler: the dot itself is purely informational. The row
// is already clickable (SidebarMenuButton / TreeRow), and clicking
// navigates the user to the page where the inline review UI (Phase C)
// renders the actual Accept / Reject affordances.

import { cn } from '@/lib/utils'
import { usePendingChangesStore } from '@/state/pendingChangesStore'

interface Props {
  /** Doc slug. Looked up against the store to decide colour. */
  slug: string
  /** Override for cases where the row's icon container expects a
   * different bounding box. Default matches Tabler icon size 16. */
  className?: string
}

export function PendingDot({ slug, className }: Props) {
  const hasPending = usePendingChangesStore((s) =>
    Object.values(s.byId).some(
      (c) => c.status === 'pending' && c.pageSlug === slug,
    ),
  )
  return (
    <span
      aria-hidden
      className={cn(
        // 16px outer container matches the size: 16 the Tabler icon
        // used to occupy, keeping row alignment identical.
        'inline-flex h-4 w-4 items-center justify-center',
        className,
      )}
    >
      <span
        className={cn(
          // ~5px dot. `transition-colors` so the flip from pending
          // to settled (or back) reads as a soft fade rather than
          // a hard swap.
          'h-1.5 w-1.5 rounded-full transition-colors',
          hasPending ? 'bg-info' : 'bg-muted-foreground/40',
        )}
      />
    </span>
  )
}
