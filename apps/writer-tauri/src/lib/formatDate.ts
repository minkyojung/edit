// Shared date formatting for metadata surfaces (document info, properties
// panel). Keeps the locale-friendly "Jul 19, 2026" rendering in one place.

/** Format an ISO date string as a short localized date (e.g. "Jul 19, 2026").
 * Returns the raw string on an unparseable input so nothing is silently lost. */
export function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}
