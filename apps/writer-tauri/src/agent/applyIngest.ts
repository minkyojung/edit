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
import type { IngestProposal } from '@/agent/ingest/types'

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
    // `addToHistory: false` so the user's Cmd+Z stack doesn't pick
    // up this AI-driven append. The intent of Cmd+Z is "undo what
    // *I* just did" — undoing an Accept this way would also wipe
    // the body without re-surfacing the inline widget, leaving the
    // user with "text vanished, can't bring it back". The right
    // surface for reversing an Accept is the inline Reject button,
    // not the undo stack. (A future phase may wrap Accept + body
    // append into one history-aware transaction so Cmd+Z reads as
    // "re-stage the change"; until then this guard prevents the
    // obvious data-loss-looking failure mode.)
    view.dispatch(prep.tr.setMeta('addToHistory', false))
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

/** Replace `before` text with `after` in wiki page `slug`. Mirrors
 * the `appendMarkdownToWikiPage` flow but for the "chat Edit"
 * shape — the LLM proposed `before → after`, the user clicked
 * Keep, we now apply it ourselves (the SDK no longer touches disk
 * for chat edits; see E6 host-applies pattern in sidecar).
 *
 * Two paths, same as append:
 *   - **Active** — PM-transaction dispatch so the user sees the
 *     swap instantly. The doc-flush loop persists on the next tick.
 *   - **Inactive** — string replace on the `.md` then `reloadFromVault`
 *     so any pre-mounted handle picks up the new content.
 *
 * Returns false when:
 *   - slug isn't in the catalog,
 *   - `before` can't be located in the doc / file (the change is
 *     stale relative to the current content),
 *   - vault IO failed.
 * Caller treats false as "decision recorded, but no disk effect" —
 * the store entry is still flipped to `accepted` so the inline
 * widget vanishes; the data on disk just doesn't get the swap. */
export async function applyReplaceInWikiPage(
  slug: string,
  before: string,
  after: string,
): Promise<boolean> {
  if (before.length === 0) return false
  const resolvedAfter = resolveWikilinksInMarkdown(after)

  const docs = useDocsStore.getState()
  const known = docs.knownDocs.find((d) => d.slug === slug && !d.archivedAt)
  if (!known) {
    console.warn('[applyReplace] unknown slug', slug)
    return false
  }

  // Active path: locate `before` in the PM doc, replace the range
  // with the parsed `after` fragment. The PM dispatch route gives
  // instant visual feedback — the chief reason E6 exists.
  const view = useEditorViewStore.getState().view
  const activeSlug = getActiveSlugFromHash()
  if (view && activeSlug === slug) {
    const range = findTextRangeInDoc(view.state.doc, before)
    if (!range) {
      console.warn('[applyReplace] before-text not found in active doc', slug)
      // Fall through to the inactive path so the on-disk content
      // can still pick up the swap if the literal string is there
      // (markdown syntax that PM normalises away — bullets, headings
      // — round-trip via the file). The active-doc reload will then
      // bring the new content back into PM.
    } else {
      const parser = useEditorViewStore.getState().parser
      if (!parser) {
        console.warn('[applyReplace] parser unavailable')
        return false
      }
      const parsed = parser(resolvedAfter)
      if (!parsed) {
        console.warn('[applyReplace] parse failed')
        return false
      }
      const tr = view.state.tr.replaceWith(
        range.from,
        range.to,
        parsed.content,
      )
      // `addToHistory: false` matches the append path — Cmd+Z
      // shouldn't wipe an AI-driven swap because there's no widget
      // to re-summon afterwards. The right reverse-Apply surface is
      // the inline Reject button while the change is still pending.
      view.dispatch(tr.setMeta('addToHistory', false))
      return true
    }
  }

  // Inactive path (or active-but-not-found fallback): string replace
  // on disk + reload. Same .md / .ydoc lockstep ordering as the
  // append path — write .md first, then reload so the docFileSync
  // observer marks dirty and flushes both stores together.
  const getDoc = (s: string) => docs.knownDocs.find((d) => d.slug === s)
  const mdPath = pathForDoc(known, getDoc)
  if (!mdPath) {
    console.warn('[applyReplace] no md path for', slug)
    return false
  }
  if (!(await vaultFileExists(mdPath))) {
    console.warn('[applyReplace] file does not exist', mdPath)
    return false
  }
  let existing: string
  try {
    existing = await readVaultFile(mdPath)
  } catch (err) {
    console.warn('[applyReplace] read failed', mdPath, err)
    return false
  }
  if (!existing.includes(before)) {
    console.warn('[applyReplace] before-text not found on disk', slug, mdPath)
    return false
  }
  // First occurrence only — matches the SDK Edit tool's default
  // semantics. If a future caller wants global replace it can be
  // added as a flag.
  const next = existing.replace(before, resolvedAfter)
  try {
    await writeVaultFile(mdPath, next)
  } catch (err) {
    console.error('[applyReplace] write failed', mdPath, err)
    return false
  }
  try {
    await docs.ensureHandle(slug)
    await docs.reloadFromVault(slug)
  } catch (err) {
    console.warn('[applyReplace] Y.Doc resync failed', slug, err)
  }
  return true
}

/** Overwrite wiki page `slug` with `content` (the chat Write tool
 * shape). Active doc: PM dispatch that replaces the entire body.
 * Inactive: write file + reload. */
export async function applyWriteWikiPage(
  slug: string,
  content: string,
): Promise<boolean> {
  const resolved = resolveWikilinksInMarkdown(content)
  const docs = useDocsStore.getState()
  const known = docs.knownDocs.find((d) => d.slug === slug && !d.archivedAt)
  if (!known) {
    console.warn('[applyWrite] unknown slug', slug)
    return false
  }

  const view = useEditorViewStore.getState().view
  const activeSlug = getActiveSlugFromHash()
  if (view && activeSlug === slug) {
    const parser = useEditorViewStore.getState().parser
    if (!parser) return false
    const parsed = parser(resolved)
    if (!parsed) return false
    const tr = view.state.tr.replaceWith(
      0,
      view.state.doc.content.size,
      parsed.content,
    )
    view.dispatch(tr.setMeta('addToHistory', false))
    return true
  }

  const getDoc = (s: string) => docs.knownDocs.find((d) => d.slug === s)
  const mdPath = pathForDoc(known, getDoc)
  if (!mdPath) return false
  try {
    await writeVaultFile(mdPath, resolved)
  } catch (err) {
    console.error('[applyWrite] write failed', mdPath, err)
    return false
  }
  try {
    await docs.ensureHandle(slug)
    await docs.reloadFromVault(slug)
  } catch (err) {
    console.warn('[applyWrite] Y.Doc resync failed', slug, err)
  }
  return true
}

/** Locate `target` text inside a single PM text node and return its
 * range. Mirrors the inline-review plugin's resolver semantics:
 *   - literal match first
 *   - markdown line-prefix strip fallback (`* `, `- `, `# `, `> `, `1. `)
 * Returns null when the target isn't in any single text node — the
 * caller falls back to the disk path. */
function findTextRangeInDoc(
  doc: import('@milkdown/kit/prose/model').Node,
  target: string,
): { from: number; to: number } | null {
  if (target.length === 0) return null
  const literal = findRange(doc, target)
  if (literal) return literal
  const stripped = stripMarkdownLinePrefixes(target)
  if (stripped !== target && stripped.length > 0) {
    return findRange(doc, stripped)
  }
  return null
}

function findRange(
  doc: import('@milkdown/kit/prose/model').Node,
  target: string,
): { from: number; to: number } | null {
  let result: { from: number; to: number } | null = null
  doc.descendants((node, pos) => {
    if (result) return false
    if (!node.isText || !node.text) return true
    const idx = node.text.lastIndexOf(target)
    if (idx >= 0) {
      result = { from: pos + idx, to: pos + idx + target.length }
      return false
    }
    return true
  })
  return result
}

function stripMarkdownLinePrefixes(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/^(?:[*+-]|#{1,6}|>|\d+\.)\s+/, ''))
    .join('\n')
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

/** One row in the commit body — what the LLM proposed for a single
 * target page, with the source line that drove it. */
export interface AppliedProposalForCommit {
  /** Display title of the wiki page the bullets landed on. Used as
   * the per-row header in the body. */
  targetTitle: string
  /** The proposal that was successfully applied. */
  proposal: IngestProposal
}

/** Build a multi-line commit message body from the proposals an
 * ingest pass landed. The body sits below the subject (which the
 * caller controls) and gives the user — when they hover or expand
 * the Review panel card — enough context to judge the change without
 * leaving the panel:
 *
 *   <entity> → <target>
 *     Source: "<sourceQuote>"
 *     Why:    <rationale>
 *
 * `Source` and `Why` lines are omitted when the LLM didn't supply
 * the matching field, so the row collapses to a single header line
 * for terse proposals. Empty input returns an empty string —
 * caller can decide whether to commit subject-only or skip body.
 *
 * Exported for testing + reuse by the chat-handoff site. */
export function buildIngestCommitBody(
  applied: AppliedProposalForCommit[],
  sourceLabel: string,
): string {
  if (applied.length === 0) return ''
  const rows: string[] = []
  for (const { targetTitle, proposal } of applied) {
    const lines: string[] = []
    lines.push(`→ ${targetTitle}`)
    if (proposal.sourceQuote) {
      lines.push(`  Source: "${proposal.sourceQuote}"`)
    }
    if (proposal.rationale) {
      lines.push(`  Why:    ${proposal.rationale}`)
    }
    rows.push(lines.join('\n'))
  }
  // Trailing "From: <sourceLabel>" so the body always names the
  // ingest source — useful when the same target page got updates
  // from multiple sources in close succession.
  rows.push(`From: ${sourceLabel}`)
  return rows.join('\n\n')
}
