// Resolving a path the model gave us into a note the store knows, and saying
// what happened either way.
//
// `set_note_status` / `set_note_tags` used to do this inline with two
// `console.warn(...); return` exits, so a path that didn't resolve — or a note
// that wasn't there — ended the handler with the model already told "Status
// set". Nothing was written and nothing said so.
//
// Split out because the resolution has three outcomes and the listener has one
// job (answer the host). Keeping them together is how the two silent exits got
// there in the first place.

import { pathToKnownSlug } from '@/lib/docPaths'
import { useDocsStore } from '@/state/docsStore'
import { getActiveVaultPath } from '@/state/settingsStore'
import type { MetadataOutcome } from '@/state/docsStore/types'
import { toVaultRelative } from './toPendingChange'

/** Resolve `path` to a known note and run `write` on it.
 *
 * A path that won't map to the vault and a path with no note behind it are the
 * same thing to the model — it named somewhere that isn't a note — so both
 * report `no-such-note` rather than inventing a third reason for a distinction
 * only this function can see. `write` reports the rest. */
export function resolveAndSet(
  path: string,
  write: (slug: string) => MetadataOutcome,
): MetadataOutcome {
  const rel = toVaultRelative(path, getActiveVaultPath())
  if (!rel) return { ok: false, reason: 'no-such-note' }
  const slug = pathToKnownSlug(rel, useDocsStore.getState().knownDocs)
  if (!slug) return { ok: false, reason: 'no-such-note' }
  return write(slug)
}
