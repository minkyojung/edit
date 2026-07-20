// Presentation metadata for a note's workflow `status` — the Korean
// labels and colors, kept in one place so the header badge and the
// sidebar tree dot never drift. The status VALUES live in docPaths.ts
// (persisted); this file is UI-only (labels + Tailwind classes).

import type { DocStatus } from './docPaths'
import type { badgeVariants } from '@/components/ui/badge'
import type { VariantProps } from 'class-variance-authority'

type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>['variant']>

/** Display label for each status. */
export const STATUS_LABEL: Record<DocStatus, string> = {
  'not-started': 'Not started',
  'in-progress': 'In progress',
  done: 'Done',
}

/** Badge variant per status (used by the header control). */
export const STATUS_BADGE_VARIANT: Record<DocStatus, BadgeVariant> = {
  'not-started': 'outline',
  'in-progress': 'warning',
  done: 'success',
}

/** Dot background class per status (used by the sidebar tree row). */
export const STATUS_DOT_CLASS: Record<DocStatus, string> = {
  'not-started': 'bg-muted-foreground/40',
  'in-progress': 'bg-warning',
  done: 'bg-success',
}
