// Inbox router PoC — route ONE inbox capture into wiki + daily.
//
// Reuses the wiki ingest LLM choreography (runIngestCore: assembleContext +
// the submit_ingest_result relay tool + structured-output parsing) but
// injects the router prompt variant. Inspect-only: it returns the routing
// result WITHOUT staging proposals or writing the daily — the point of this
// PoC is to eyeball routing quality before building any apply / trigger.
//
//   await __route('<inboxSlug>')   // dev console
//
// returns { proposals (→wiki), dailyEntries (→daily), raw, malformed }.

import { useDocsStore } from '@/state/docsStore'
import { runIngestCore } from '@/agent/ingest'
import { readDocMarkdown } from '@/agent/ingest/readDoc'
import type { IngestProposal } from '@/agent/ingest/types'
import { readVaultFile } from '@/lib/vault'
import { splitFrontmatter } from '@/lib/frontmatter'
import { composeRouterSystemPrompt, buildRouterPrompt } from './prompts'

export interface RouteResult {
  /** KNOWLEDGE facts → wiki pages (same shape as ingest proposals). */
  proposals: IngestProposal[]
  /** ACTION / INTERPRETATION / EVENT facts → today's daily, one per line
   *  (split out of the repurposed `logEntry` channel). */
  dailyEntries: string[]
  /** Raw assistant text, for debugging a malformed pass. */
  raw: string
  /** True when the model emitted text but no valid tool call. */
  malformed: boolean
}

/** Run the router pass against an inbox note and return its routing result.
 *  No disk writes, no proposal staging — inspect-only. Throws on an unknown
 *  slug; returns an empty result for an empty body. */
export async function routeInboxNote(slug: string): Promise<RouteResult> {
  console.log('[router] start', slug)
  const known = useDocsStore.getState().knownDocs.find((d) => d.slug === slug)
  if (!known) throw new Error(`unknown doc: ${slug}`)

  // Prefer the live (possibly-unsaved) body if the note is open in the
  // editor; otherwise read it from disk. Inbox captures are usually NOT
  // open, so readDocMarkdown (handle-only) returns '' for them — the disk
  // fallback (strip frontmatter → body) is the normal path here.
  let md = readDocMarkdown(slug)
  let source = md ? 'handle' : 'none'
  if (!md && known.relPath) {
    try {
      md = splitFrontmatter(await readVaultFile(known.relPath)).body.trim()
      source = md ? 'disk' : 'disk-empty'
    } catch (err) {
      console.warn('[router] disk read failed', known.relPath, err)
      source = 'disk-error'
    }
  }
  console.log('[router] body', { chars: md.length, source, relPath: known.relPath })
  if (!md) return { proposals: [], dailyEntries: [], raw: '', malformed: false }
  console.log('[router] calling model…')

  const sourceLabel = known.title?.trim() || known.relPath || slug
  let core
  try {
    // awaitChatRun (inside runIngestCore) has no timeout of its own — if the
    // app reloads mid-call the Tauri callback is orphaned and the run never
    // settles. Cap the wait so a hung pass surfaces instead of spinning
    // forever. (The sidecar run still settles on its own idle timeout.)
    core = await Promise.race([
      runIngestCore({
        text: md,
        sourceLabel,
        composeSystem: composeRouterSystemPrompt,
        buildUser: buildRouterPrompt,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                '[router] model call timed out (180s) — likely an orphaned callback from an app reload; rerun without reloading mid-call, or try a smaller capture',
              ),
            ),
          180_000,
        ),
      ),
    ])
  } catch (err) {
    console.error('[router] model call failed', err)
    throw err
  }
  console.log('[router] model returned', {
    malformed: core.malformed,
    rawChars: core.raw.length,
  })

  const dailyEntries = (core.logEntry ?? '')
    // The model sometimes emits literal "\n" escapes instead of real
    // newlines, which would otherwise leave every daily bullet fused into
    // one entry — normalize before splitting.
    .replace(/\\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  console.log('[router] routed', {
    slug,
    sourceLabel,
    wiki: core.proposals.length,
    daily: dailyEntries.length,
    malformed: core.malformed,
  })

  return {
    proposals: core.proposals,
    dailyEntries,
    raw: core.raw,
    malformed: core.malformed,
  }
}

/** List inbox captures (slug + title) — `useDocsStore` isn't a console
 *  global, so this is the easy way to grab a slug for __route. */
function listInboxNotes(): Array<{ slug: string; title?: string; relPath?: string }> {
  return useDocsStore
    .getState()
    .knownDocs.filter((d) => d.relPath?.startsWith('inbox/'))
    .map((d) => ({ slug: d.slug, title: d.title, relPath: d.relPath }))
}

/** Dev-only console handles for prompt-tuning, mirroring __ingest.
 *
 *   __inbox()                 // list inbox notes → pick a slug
 *   await __route('<slug>')   // route that note (inspect-only)
 */
if (import.meta.env.DEV) {
  const w = window as unknown as {
    __route: typeof routeInboxNote
    __inbox: typeof listInboxNotes
  }
  w.__route = routeInboxNote
  w.__inbox = listInboxNotes
}
