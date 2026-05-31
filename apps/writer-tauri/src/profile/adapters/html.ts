// Small HTML utilities shared by the adapters. Kept here so each
// adapter file stays focused on its own format.

/** Resolve a relative URL against a base. Returns the input unchanged
 * if it's already absolute or if resolution fails. */
export function resolveUrl(href: string, base: string): string {
  try {
    return new URL(href, base).toString()
  } catch {
    return href
  }
}
