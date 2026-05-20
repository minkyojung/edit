// Source-agnostic ingest entry for the first-run BootstrapDialog
// (and any future "import from foreign source" flow). Wraps
// runIngestCore with the three bootstrap-specific concerns the
// daily-anchored runIngest doesn't apply:
//
//   1. ydoc is best-effort. The bootstrap can fire before any doc
//      is open, in which case chat-activity assembly skips silently
//      (runIngestCore handles ydoc=null already).
//   2. sinceTs = 0. There's no prior watermark to honour — every
//      compaction-eligible thread is fair game. compactChatThread's
//      own cache prevents redundant LLM work across files.
//   3. Direct enqueue. Daily's caller (useIdleTrigger) decides when
//      to enqueue/persist; the bootstrap caller is a file/URL loop
//      that has no further state to merge, so we enqueue here and
//      callers just await the proposal count.
//
// Block-hash dedup and lastIngestedAt persistence are deliberately
// skipped — the bootstrap source is "first time" by definition, so
// caching against past passes would either be empty (no win) or
// wrongly suppress imported content that overlaps daily fragments.

import { useDocsStore } from '@/state/docsStore'
import { useIngestStore } from '@/state/ingestStore'
import {
  runIngestCore,
  type IngestCoreResult,
} from '@/agent/ingest'

export interface BootstrapIngestArgs {
  /** Raw markdown / text from the bootstrap source. The caller has
   * already stripped frontmatter and (if needed) chunked the input
   * to fit within prompt limits. */
  text: string
  /** Display label for the user prompt and review banner. Free-form;
   * e.g. `imported/notes.md` or `url/example.com/post`. */
  sourceLabel: string
  /** Optional dedup key for the review queue. Defaults to
   * `sourceLabel` — multiple chunks of the same file share a key so
   * the banner groups them together. */
  sourceSlug?: string
}

export async function bootstrapIngest(
  args: BootstrapIngestArgs,
): Promise<IngestCoreResult> {
  const { text, sourceLabel, sourceSlug } = args

  // Best-effort active ydoc for chat-activity compaction. Null is
  // fine: runIngestCore short-circuits the chat block when ydoc is
  // null, so the LLM just sees the wiki + the bootstrap text.
  const activeSlug = useDocsStore.getState().activeSlug
  const ydoc = activeSlug
    ? useDocsStore.getState().handles[activeSlug]?.ydoc ?? null
    : null

  const result = await runIngestCore({
    text,
    sourceLabel,
    sinceTs: 0,
    ydoc,
  })

  // Only enqueue when there's something to review — empty proposals
  // with no log entry would just clutter the banner state.
  if (result.proposals.length > 0 || result.logEntry) {
    useIngestStore.getState().enqueue({
      proposals: result.proposals,
      logEntry: result.logEntry,
      sourceSlug: sourceSlug ?? sourceLabel,
      sourceLabel,
    })
  }

  return result
}

// Dev handle so the function can be invoked from DevTools before
// any UI wiring lands. Removed once D.2.3 lands the BootstrapDialog
// Stage 2 caller.
//   In DevTools:  await window.__bootstrapIngest({ text, sourceLabel: 'test' })
if (import.meta.env.DEV) {
  ;(window as unknown as { __bootstrapIngest: typeof bootstrapIngest }).__bootstrapIngest =
    bootstrapIngest
}
