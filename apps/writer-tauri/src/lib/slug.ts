// Client-side slug generator. Mirrors proof-sdk/server/slug.ts so a slug
// minted offline is indistinguishable from one the server would have
// produced — same charset, same length — and survives the round-trip
// when the registration call eventually reaches POST /documents.
//
// Used by docsStore when it creates a daily / wiki / writing doc: the
// slug is decided locally so the editor can mount and write to IndexedDB
// immediately, with the server registration call following as a
// fire-and-forget background task. This is the standard offline-first
// pattern — clients own identity, the server just records it.

const SLUG_LENGTH = 8
const SLUG_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'

export function generateClientSlug(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(SLUG_LENGTH))
  let slug = ''
  for (let i = 0; i < SLUG_LENGTH; i++) {
    slug += SLUG_CHARS[bytes[i] % SLUG_CHARS.length]
  }
  return slug
}
