// Small HTML utilities shared by the adapters. Kept here so each
// adapter file stays focused on its own format.

/** Strip HTML tags and collapse whitespace. The LLM only needs the
 * text signal — perfect markdown formatting isn't worth a dep. */
export function htmlToPlainText(html: string): string {
  // DOMParser handles entities and malformed markup more reliably
  // than a regex sweep. We yank textContent and normalise spaces.
  const doc = new DOMParser().parseFromString(html, 'text/html')
  // Drop script/style outright so their inner text doesn't bleed in.
  doc.querySelectorAll('script, style, noscript').forEach((n) => n.remove())
  const text = doc.body?.textContent ?? ''
  return text.replace(/\s+/g, ' ').trim()
}

/** Resolve a relative URL against a base. Returns the input unchanged
 * if it's already absolute or if resolution fails. */
export function resolveUrl(href: string, base: string): string {
  try {
    return new URL(href, base).toString()
  } catch {
    return href
  }
}
