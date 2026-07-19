// Which property rows a note's panel shows. Kept in its own module (not the
// component file) so PropertiesPanel exports only components — that lets React
// Fast Refresh hot-reload the panel without a full page reload.

import type { KnownDoc } from '@/state/docsStore'

export type PropKind = 'status' | 'tags' | 'created' | 'source' | 'read'

/** `status` and `tags` are always present (editable everywhere, shown even
 * when empty as a fill-me affordance); the rest appear only when their
 * backing field exists, so read-only rows never render as an empty line. */
export function visibleProps(
  known: Pick<KnownDoc, 'createdAt' | 'sourceUrl'>,
): PropKind[] {
  const rows: PropKind[] = ['status', 'tags']
  if (known.createdAt) rows.push('created')
  if (known.sourceUrl) rows.push('source', 'read')
  return rows
}
