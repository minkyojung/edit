// Sidebar dot indicator — replaces the per-doc file icon in the
// sidebar tree. The dot is the user's only signal that an AI
// surface has touched that page since they last looked.
//
// Visual states:
//   - default: a faint round dot that reads as "just a list-item
//     bullet", same footprint as the previous IconFileDescription so
//     row alignment stays put.
//   - unviewed: same dot in `bg-info` (the app's accent blue, the
//     same tint the Chat capsule and other "AI-attention" affordances
//     use). Subtle but discoverable while the user is browsing.
//
// Lifecycle (intentionally decoupled from decision state — Phase E2.8):
//   - Blue when:    an AI change targets this page and the user has
//                   not yet visited (`viewedAt === null`).
//   - Grey when:    the user has navigated to the page since the
//                   change was queued, OR the user explicitly
//                   rejected the change in chat.
//
// Apply / Keep alone does NOT clear the dot — the file may have
// changed but the user hasn't seen the result yet, and the dot is
// the signal to "go look". This matches Slack / Notion / Linear's
// "unread badge" pattern rather than an "inbox/to-do" pattern.
//
// No click handler: the dot itself is purely informational. The row
// is already clickable (SidebarMenuButton / TreeRow), and clicking
// navigates the user to the page (which both clears this dot and
// surfaces the inline review widget if the change is still pending).

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
  // `viewedAt === null` AND not rejected — see store's
  // `pagesWithUnviewed` selector for the matching set-level form.
  // Inlined per-slug here to keep React equality cheap (boolean vs
  // a Set that allocates each call).
  const hasUnviewed = usePendingChangesStore((s) =>
    Object.values(s.byId).some(
      (c) =>
        c.pageSlug === slug &&
        c.status !== 'rejected' &&
        c.viewedAt === null,
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
          hasUnviewed ? 'bg-info' : 'bg-muted-foreground/40',
        )}
      />
    </span>
  )
}
