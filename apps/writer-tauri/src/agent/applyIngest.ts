// Apply layer for ingest — the "COMPILE" step in Karpathy's
// LLM-wiki pipeline. Takes proposals the model emitted and lands them
// directly into the target wiki pages (Phase 2.A flip — review queue
// removed). Two surfaces:
//
//   - appendMarkdownToWikiPage(slug, md)
//       Append `md` to the end of a wiki page. Active doc takes the
//       PM-transaction path so the user sees the insertion live;
//       inactive doc routes through the on-disk `.md` + a Y.Doc
//       reload so any future open of the page shows fresh content.
//   - appendToSystemLog(line)
//       Sugar for "append to the system:log page", which is the
//       agent's append-only timeline.
//
// Legacy: `applyPendingLogsForView` drained queued log entries when
// the user navigated to wiki:log. With Phase 2.A's direct-write flow
// the queue stays empty in practice, so this is a no-op safety net
// kept for compatibility until Phase 3.A removes the queue itself.

import type { EditorView } from '@milkdown/kit/prose/view'
import { useIngestStore } from '@/state/ingestStore'
import { useEditorViewStore } from '@/state/editorViewStore'
import { useDocsStore } from '@/state/docsStore'
import { prepareMarkdownAppend } from '@/lib/markdownAppend'
import { resolveWikilinksInMarkdown } from '@/lib/wikilinkResolve'
import { readVaultFile, writeVaultFile, vaultFileExists } from '@/lib/vault'
import { pathForDoc } from '@/lib/docPaths'
import { getActiveSlugFromHash } from '@/lib/viewUrl'
import { ensureLogWikiSlug } from '@/state/wikiService'

/** Drain queued log entries into wiki:log. Called from
 * useApplyPendingLogs when the user navigates to the log page.
 * Each entry is a pre-formatted markdown line (`## [DATE] kind |
 * summary`) and goes through the shared markdown-append helper so
 * headings, links, and any other markdown render — they used to
 * land as literal text because the old appender skipped the
 * parser. */
export function applyPendingLogsForView(view: EditorView): number {
  const logs = useIngestStore.getState().pendingLogs
  if (logs.length === 0) return 0
  const applied: string[] = []
  for (const entry of logs) {
    const prep = prepareMarkdownAppend(view, entry.line)
    if (!prep) {
      console.warn('[ingest:log] markdown parse failed; leaving in queue', entry.line)
      continue
    }
    view.dispatch(prep.tr)
    applied.push(entry.id)
  }
  if (applied.length > 0) {
    useIngestStore.getState().remove({ proposalIds: [], logIds: applied })
  }
  return applied.length
}

/** Append `markdown` to the end of wiki page `slug`. Caller passes
 * the raw markdown the LLM produced (with `[[Title]]` tokens); we
 * resolve those to real markdown links before writing.
 *
 * Two paths:
 *
 *   - **Active** — the user has this wiki page open in the editor.
 *     We use `prepareMarkdownAppend` + `view.dispatch` so the
 *     insertion arrives via the live PM transaction (mirrors the
 *     legacy `acceptProposal` path). The doc-flush loop persists to
 *     `.md` / `.ydoc` on the next 2 s tick.
 *
 *   - **Inactive** — most common. The user is editing a daily and
 *     the LLM is filing into Sarah's page. No view is mounted; we
 *     write the combined markdown to `.md` directly via the vault
 *     layer and then call `reloadFromVault` so any pre-mounted handle
 *     (e.g. one warmed during boot) picks up the new content. A
 *     future open of the page renders from the freshly-written `.md`
 *     naturally.
 *
 * Returns false on any failure that stopped the write (parser
 * missing, vault path unresolved, IO error). Errors are logged but
 * don't throw — the caller iterates over multiple proposals and one
 * bad row shouldn't abort the rest.
 */
export async function appendMarkdownToWikiPage(
  slug: string,
  markdown: string,
): Promise<boolean> {
  const trimmed = markdown.trim()
  if (trimmed.length === 0) return false

  const resolved = resolveWikilinksInMarkdown(trimmed)

  const docs = useDocsStore.getState()
  const known = docs.knownDocs.find((d) => d.slug === slug && !d.archivedAt)
  if (!known) {
    console.warn('[applyIngest] unknown slug', slug)
    return false
  }

  // Active path: PM-transaction append, matches acceptProposal.
  const view = useEditorViewStore.getState().view
  const activeSlug = getActiveSlugFromHash()
  if (view && activeSlug === slug) {
    const prep = prepareMarkdownAppend(view, resolved)
    if (!prep) {
      console.warn('[applyIngest] active append: prepare returned null', slug)
      return false
    }
    view.dispatch(prep.tr)
    return true
  }

  // Inactive path: on-disk append + Y.Doc resync.
  //
  // Crucial subtlety: `.md` and `.ydoc` are two stores for the same
  // body. The doc-load path (`applyVaultBodyToYDoc`) prefers the
  // `.ydoc` binary (Tier 1) when a handle is freshly built, because
  // it preserves mark anchors. If we only updated `.md`, the next
  // time the user opens that page Tier 1 would resurrect the OLD
  // body from the stale `.ydoc`, the auto-flush would write that
  // stale body back to `.md`, and our append would silently
  // disappear. That's exactly the "log said added but page is empty"
  // mismatch we hit.
  //
  // Order matters:
  //   1. writeVaultFile(.md)   — the new combined body lands on disk
  //   2. ensureHandle           — Y.Doc handle exists in memory
  //   3. reloadFromVault        — `reload: true` path skips Tier 1
  //                               (.ydoc) and rehydrates the fragment
  //                               from the fresh `.md`. The
  //                               docFileSync observer then marks
  //                               the slug dirty so the next flush
  //                               writes a fresh `.ydoc` in lockstep
  //                               with `.md`.
  //
  // Net effect: `.md` / `.ydoc` / in-memory Y.Doc all agree on the
  // appended body, and any subsequent flush is a no-op rather than
  // a destructive overwrite.
  const getDoc = (s: string) => docs.knownDocs.find((d) => d.slug === s)
  const mdPath = pathForDoc(known, getDoc)
  if (!mdPath) {
    console.warn('[applyIngest] no md path for', slug)
    return false
  }
  let existingMd = ''
  if (await vaultFileExists(mdPath)) {
    try {
      existingMd = await readVaultFile(mdPath)
    } catch (err) {
      console.warn('[applyIngest] read failed for', mdPath, err)
      // Treat as empty — better to write a fresh page than to abort.
    }
  }
  // trimEnd collapses any trailing blank line into the separator
  // calculation; resolved was trimmed up front so the trailing `\n`
  // is the canonical one.
  const head = existingMd.trimEnd()
  const sep = head.length > 0 ? '\n\n' : ''
  const combined = `${head}${sep}${resolved}\n`
  try {
    await writeVaultFile(mdPath, combined)
  } catch (err) {
    console.error('[applyIngest] write failed for', mdPath, err)
    return false
  }
  // Force the Y.Doc to mirror the fresh `.md`. ensureHandle is
  // idempotent (no-op when one already exists); reloadFromVault
  // routes through `applyVaultBodyToYDoc({ reload: true })`, which
  // is the only path that bypasses the `.ydoc` Tier-1 preference.
  try {
    await docs.ensureHandle(slug)
    await docs.reloadFromVault(slug)
  } catch (err) {
    console.warn('[applyIngest] Y.Doc resync failed for', slug, err)
    // Disk write succeeded; a future ensureHandle that bypasses Tier
    // 1 (rare — usually only when .ydoc is missing) still recovers.
    // Don't surface to caller — the on-disk truth is correct.
  }
  return true
}

/** Append a log line to the system:log page. Creates the page on
 * first use (idempotent via ensureLogWikiSlug). The host of the
 * agent's append-only timeline ("## [2026-05-24] ingest | daily/...
 * — added Sarah's promotion"). */
export async function appendToSystemLog(line: string): Promise<void> {
  const trimmed = line.trim()
  if (trimmed.length === 0) return
  const slug = await ensureLogWikiSlug()
  if (!slug) {
    console.warn('[applyIngest] could not ensure system:log slug')
    return
  }
  await appendMarkdownToWikiPage(slug, trimmed)
}
