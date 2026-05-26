// Ingest engine entry point — Karpathy-style "user writes notes,
// LLM maintains the wiki" pattern. One call:
//
//   const result = await runIngest(noteSlug)
//
// reads the note's markdown, snapshots every wiki page, asks Haiku
// what should change in the wiki to reflect the new note, and
// returns proposals WITHOUT applying them. Application (ydoc append)
// and the trigger (idle / doc-close) are separate concerns layered
// on top.
//
// Why a fresh sessionId per call: ingest is one-shot — there's no
// multi-turn history to resume. We want each ingest evaluated
// against the live wiki snapshot, not against a stale cached prefix.

import { invoke } from '@tauri-apps/api/core'
import { awaitChatRun } from '@/agent/chatRun'
import { useDocsStore, isWikiDoc } from '@/state/docsStore'
import { getActiveSlugFromHash } from '@/lib/viewUrl'
import { useIngestStore } from '@/state/ingestStore'
import { pickNewBlocks } from '@/lib/blockHash'
import {
  ensureConventionsWikiSlug,
  ensureProfileWikiSlug,
} from '@/state/wikiService'
import { assembleContext } from '@/agent/contextPipeline'
import { getActiveVaultPath } from '@/state/settingsStore'
import { buildPrompt, composeSystemPrompt } from './prompts'
import { sanitizeIngestResult, type IngestToolInput } from './parse'
import { readDocMarkdown, todayLocalDate } from './readDoc'
import type {
  IngestCoreArgs,
  IngestCoreResult,
  IngestResult,
} from './types'

const INGEST_MODEL = 'claude-haiku-4-5-20251001'

// awaitChatRun lives in @/agent/chatRun — generic over the
// structured-output event name so the Profile bootstrap can reuse
// the same listener choreography (its event is `profile:result`).

/** Source-agnostic ingest core. Takes pre-filtered markdown plus a
 * display label and runs the wiki-context-aware LLM pass. No store
 * reads, no slug lookups, no block-hash dedup — the caller (daily
 * `runIngest` or bootstrap `bootstrapIngest`) handles whatever
 * source-specific filtering / persistence it needs.
 *
 * Returned shape mirrors `IngestResult` minus `ingestedHashes`,
 * which is daily-only state (bootstrap doesn't dedup by hash). */
export async function runIngestCore(args: IngestCoreArgs): Promise<IngestCoreResult> {
  const { text, sourceLabel } = args

  // Seed the conventions page on first need so the user has
  // something to edit; assembleContext reads the result a moment
  // later. Failures degrade gracefully — empty conventions means
  // the static rules take over alone.
  await ensureConventionsWikiSlug()
  // Same lazy-seed for the self-profile page. Guarantees `wiki:profile`
  // shows up in the INDEX so the model can route self-facts there
  // even for users who skipped the URL bootstrap — the page just
  // starts empty and fills from daily activity instead.
  await ensureProfileWikiSlug()
  // Karpathy / Claude Code shape: CLAUDE.md + profile + conventions
  // ride the system prompt, and the agent uses the SDK's built-in
  // Read / Glob / Grep (enabled by the sidecar's `tools: { preset:
  // 'claude_code' }`) to navigate the vault on demand. Tier-3 MCP
  // tools (`read_page` / `search_wiki`) are intentionally absent
  // for ingest — the built-ins are equivalent and the model picks
  // one path instead of being offered redundant choices.
  const ctx = await assembleContext({ mode: 'ingest' })

  const prompt = buildPrompt({
    date: todayLocalDate(),
    noteLabel: sourceLabel,
    noteMarkdown: text,
  })
  const systemPrompt = composeSystemPrompt({
    claudeMd: ctx.claudeMd,
    conventions: ctx.conventions,
    selfProfile: ctx.selfProfile,
  })

  const runId = crypto.randomUUID()
  const sessionId = crypto.randomUUID()
  const finished = awaitChatRun<IngestToolInput>(runId, 'ingest:result')
  await invoke('claude_chat_start', {
    args: {
      runId,
      model: INGEST_MODEL,
      systemPrompt,
      prompt,
      // `submit_ingest_result` is the single structured-output
      // channel — exactly one call ends the run via `claude:done`.
      relayTools: ['submit_ingest_result'],
      vaultPath: getActiveVaultPath() ?? undefined,
      // Read-only built-in surface. Ingest must NOT write to disk
      // directly — the host turns proposals into wiki edits after
      // the user reviews them. Pinning `builtinTools` to the
      // navigation trio means Edit / Write / MultiEdit /
      // NotebookEdit / Bash are not just denied at canUseTool time
      // but invisible to the model (SDK strips them from the tool
      // context entirely). This is the structural guarantee: prompt
      // wording cannot regress disk safety here.
      builtinTools: ['Read', 'Glob', 'Grep'],
      effort: 'low',
      sessionId,
      // Cap the agent loop. 10 turns is generous for the "Read
      // index, Glob/Grep a couple of pages, emit the tool call"
      // pattern; runaway tool-calling either hits the cap and
      // settles (we still get whatever proposals were ready) or
      // surfaces as a malformed pass that the caller swallows.
      maxTurns: 10,
    },
  })
  const outcome = await finished
  if (!outcome.toolInput) {
    console.warn(
      '[ingest:producer] submit_ingest_result tool was not called',
      { textPreview: outcome.text.slice(0, 200) },
    )
    return {
      proposals: [],
      logEntry: null,
      raw: outcome.text,
      malformed: true,
    }
  }
  const { proposals, logEntry } = sanitizeIngestResult(outcome.toolInput)
  console.log('[ingest:producer] tool result accepted', {
    proposals: proposals.length,
    logEntry: !!logEntry,
    targets: proposals.map((p) => p.target ?? `new:${p.suggestNewPage}`),
  })
  return {
    proposals,
    logEntry,
    raw: outcome.text,
    malformed: false,
  }
}

/** Run one ingest pass against the given note slug. Reads the note,
 * snapshots the wiki, calls Haiku, returns proposals (no apply).
 * Throws on transport / SDK errors. Returns malformed=true when the
 * model emitted text but it didn't parse — caller can decide whether
 * to retry or surface as a soft warning. */
export async function runIngest(noteSlug: string): Promise<IngestResult> {
  const known = useDocsStore
    .getState()
    .knownDocs.find((d) => d.slug === noteSlug)
  if (!known) throw new Error(`unknown doc: ${noteSlug}`)
  if (isWikiDoc(known)) {
    // Agent-managed pages (system:* meta surface + wiki:custom-*
    // content) are LLM output, not input — ingesting one would
    // mean asking the model to summarize itself. The trigger layer
    // enforces this too, but guard here so console testing can't
    // accidentally poison the wiki with self-echo.
    throw new Error(`refusing to ingest an agent-managed page: ${noteSlug}`)
  }

  const fullMarkdown = readDocMarkdown(noteSlug)
  if (!fullMarkdown) {
    return {
      proposals: [],
      logEntry: null,
      raw: '',
      malformed: false,
      ingestedHashes: [],
    }
  }

  // Block-hash filter: only forward blocks the LLM hasn't seen
  // before. This is the structural dedup guard — without it, the
  // same paragraph re-sent on a later pass would re-trigger
  // proposals the user already accepted, stamping duplicate rows
  // into the wiki. `allHashes` is the *full* current snapshot
  // (not just new ones); caller persists it so deletions and
  // edits both self-heal.
  const seen = new Set(
    useIngestStore.getState().ingestedBlockHashes[noteSlug] ?? [],
  )
  const { newBlocks, allHashes } = await pickNewBlocks(fullMarkdown, seen)
  if (newBlocks.length === 0) {
    console.log('[ingest:producer] no new blocks since last pass', {
      noteSlug,
      totalBlocks: allHashes.length,
    })
    return {
      proposals: [],
      logEntry: null,
      raw: '',
      malformed: false,
      // Return the current snapshot anyway — the caller persists
      // it to reflect deletions (any hash that disappeared from
      // the body falls out of the stored set).
      ingestedHashes: allHashes,
    }
  }
  const noteMarkdown = newBlocks.map((b) => b.text).join('\n\n')
  console.log('[ingest:producer] block filter', {
    noteSlug,
    new: newBlocks.length,
    total: allHashes.length,
  })

  const noteLabel =
    known.type === 'daily' && known.date
      ? `daily/${known.date}`
      : known.title?.trim() || noteSlug

  const core = await runIngestCore({
    text: noteMarkdown,
    sourceLabel: noteLabel,
  })

  return {
    ...core,
    // Malformed pass: don't persist the hash snapshot — the LLM
    // never "consumed" these blocks, so leave the store as-is so
    // the next pass retries with the same content.
    ingestedHashes: core.malformed ? [] : allHashes,
  }
}

/** Convenience for console testing: run ingest against today's
 * daily entry without having to look up the slug manually. Returns
 * null when there's no daily for today (shouldn't happen — bootstrap
 * always creates one — but handled so the console call never throws
 * a confusing TypeError). */
export async function ingestToday(): Promise<IngestResult | null> {
  const today = todayLocalDate()
  const known = useDocsStore
    .getState()
    .knownDocs.find((d) => d.type === 'daily' && d.date === today)
  if (!known) {
    console.warn('[ingest] no daily for today:', today)
    return null
  }
  return runIngest(known.slug)
}

/** Convenience for console testing: run ingest against the currently
 * active tab. Useful when the user is iterating on a specific note
 * and wants to see what the model would propose for it. */
export async function ingestActive(): Promise<IngestResult | null> {
  const slug = getActiveSlugFromHash()
  if (!slug) {
    console.warn('[ingest] no active doc')
    return null
  }
  return runIngest(slug)
}

/** Dev-only handles so the engine is callable from the browser
 * console for prompt-tuning.
 *
 * Console usage:
 *   await __ingestToday()    // runs against today's daily
 *   await __ingestActive()   // runs against the active tab
 *   await __ingest('<slug>') // explicit slug
 */
if (import.meta.env.DEV) {
  const w = window as unknown as {
    __ingest: typeof runIngest
    __ingestToday: typeof ingestToday
    __ingestActive: typeof ingestActive
  }
  w.__ingest = runIngest
  w.__ingestToday = ingestToday
  w.__ingestActive = ingestActive
}
