// URL → adapters → 3 LLM section calls → wiki:profile.
//
// One end-to-end function (runProfilePipeline) that the onboarding
// dialog drives. The dialog passes a progress callback so it can
// render "fetching" / "section_done" cards as the run advances.
//
// Section bodies live in memory during the run; the final wiki:profile
// markdown is assembled and written once at the end. A partial failure
// (e.g. Themes throws) aborts cleanly without leaving a half-written
// page behind. Single-section regeneration (runSection) reads the
// existing page and splices the new content into just that heading's
// zone via replaceZone — other sections, the Sources list, Background,
// and Notes survive untouched.

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import {
  parseChatEvent,
  parseDoneEvent,
  parseErrorEvent,
} from '@/agent/chat/eventSchemas'
import { discoverAndFetch, type Document } from './adapters'
import {
  PROFILE_SECTIONS,
  PROFILE_SYSTEM_PREAMBLE,
  type ProfileSectionKey,
} from './conventions'
import { assembleProfileMarkdown, replaceZone } from './markers'
import { hasAnySources, readAllSources, saveSources } from './sources'
import { useDocsStore } from '@/state/docsStore'
import {
  ensureProfileWikiSlug,
  readSelfProfile,
} from '@/state/wikiService'

// Haiku for the section calls. The OAuth-token budget the app
// shares with chat/ingest/Claude Code itself is the real bottleneck
// (not per-minute rate limit), so cost-per-call matters. Haiku is
// ~3x cheaper than Sonnet and the Voice/Themes/About extraction is
// well within Haiku's competence — stylistic summarisation, not
// reasoning. If About quality regresses we can selectively promote
// it to Sonnet later.
const MODEL = 'claude-haiku-4-5'
// Per-post truncation before the prompt. 2000 chars × 8 posts =
// ~16k chars per call — comfortably below the OAuth-token per-
// minute input limit so the three section calls don't 429. Voice
// and theme signal saturates well before 2000 chars per post, so
// the larger cap from earlier iterations was unnecessary.
const PER_POST_CHAR_CAP = 2000

// 429 retry policy. Exponential backoff: 1s, 2s, 4s. Three retries
// covers the typical per-minute window resets without making the
// user wait forever on a hard outage.
const MAX_RETRY_ATTEMPTS = 4
const RETRY_BASE_DELAY_MS = 1000

const SECTION_ORDER: ProfileSectionKey[] = ['voice', 'themes', 'about']

export type PipelineProgress =
  | { kind: 'discovering' }
  | { kind: 'fetched'; adapter: string; count: number }
  | { kind: 'no_documents' }
  | { kind: 'section_start'; section: ProfileSectionKey }
  | { kind: 'section_done'; section: ProfileSectionKey }
  | { kind: 'saving' }
  | { kind: 'done'; slug: string }
  | { kind: 'error'; message: string }

export interface PipelineResult {
  ok: boolean
  slug?: string
  reason?: 'no_documents' | 'llm_failed' | 'write_failed'
}

export async function runProfilePipeline(
  inputUrl: string,
  onProgress: (p: PipelineProgress) => void,
): Promise<PipelineResult> {
  onProgress({ kind: 'discovering' })
  const { adapter, documents } = await loadOrFetchSources(inputUrl)
  if (documents.length === 0) {
    onProgress({ kind: 'no_documents' })
    return { ok: false, reason: 'no_documents' }
  }
  onProgress({ kind: 'fetched', adapter, count: documents.length })

  const sections: Partial<Record<ProfileSectionKey, string>> = {}
  for (const key of SECTION_ORDER) {
    onProgress({ kind: 'section_start', section: key })
    try {
      sections[key] = await generateSection(key, documents)
    } catch (err) {
      console.error('[profile] section failed', { section: key, err })
      const msg = err instanceof Error ? err.message : String(err)
      onProgress({ kind: 'error', message: `${key}: ${msg || '(no message)'}` })
      return { ok: false, reason: 'llm_failed' }
    }
    onProgress({ kind: 'section_done', section: key })
  }

  onProgress({ kind: 'saving' })
  const markdown = assembleMarkdownFromSections(sections, documents)
  const slug = await writeWikiProfile(markdown)
  if (!slug) {
    return { ok: false, reason: 'write_failed' }
  }
  onProgress({ kind: 'done', slug })
  return { ok: true, slug }
}

/** Regenerate a single zone in place. Reads the existing wiki:profile
 * markdown, runs the LLM against the persisted sources, then splices
 * the new content under the matching heading via replaceZone. Other
 * zones — including any user edits in Background / Notes — survive
 * untouched. Falls back to a full rebuild when the page hasn't been
 * created yet (no heading to splice into). */
export async function runSection(
  key: ProfileSectionKey,
): Promise<{ ok: true; slug: string } | { ok: false; reason: string }> {
  const documents = await readAllSources()
  if (documents.length === 0) {
    return { ok: false, reason: 'no_sources' }
  }

  let content: string
  try {
    content = await generateSection(key, documents)
  } catch (err) {
    console.error('[profile] runSection failed', { section: key, err })
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, reason: msg }
  }

  const slug = await ensureProfileWikiSlug()
  if (!slug) return { ok: false, reason: 'no_profile_slug' }

  const current = await readSelfProfile()
  const spliced = current ? replaceZone(current, key, content) : null
  const next =
    spliced ??
    assembleMarkdownFromSections({ [key]: content }, documents)

  const ok = await useDocsStore.getState().replaceDocBody(slug, next)
  return ok ? { ok: true, slug } : { ok: false, reason: 'write_failed' }
}

/** Prefer disk over network. If the vault already has persisted
 * sources from a previous run, reuse them — avoids re-fetching and
 * re-burning bandwidth + the user's Claude Code budget on subsequent
 * regenerations. Falls back to a live fetch when the cache is empty
 * (first run, or vault explicitly cleared by the user). */
async function loadOrFetchSources(inputUrl: string): Promise<{
  adapter: string
  documents: Document[]
}> {
  if (await hasAnySources()) {
    const cached = await readAllSources()
    if (cached.length > 0) {
      console.log('[profile] using cached sources', { count: cached.length })
      return { adapter: 'cache', documents: cached }
    }
  }

  const { adapter, documents } = await discoverAndFetch(inputUrl)
  if (documents.length > 0) {
    try {
      await saveSources(documents, adapter, inputUrl)
    } catch (err) {
      // Persistence failure isn't fatal — the pipeline can still
      // run from the in-memory documents. Next run will just refetch.
      console.warn('[profile] saveSources failed', err)
    }
  }
  return { adapter, documents }
}

async function generateSection(
  key: ProfileSectionKey,
  docs: Document[],
): Promise<string> {
  const def = PROFILE_SECTIONS[key]
  // The heading is added by the assembler — instructing the model to
  // skip it avoids the common failure of emitting "## Voice" twice
  // (model heading + our heading) when we concatenate.
  const sectionInstruction = [
    def.instruction,
    '',
    `Return ONLY the section body. Do not include the "${def.heading}" heading — the caller will add it.`,
  ].join('\n')

  // Caching strategy: system + posts go into the sidecar's systemPrompt
  // (identical across all three section calls), so the SDK's prompt cache
  // hits on calls 2 and 3. The section-specific instruction is the per-call
  // user prompt — its variance sits outside the cached system prefix.
  const postsText = renderDocsForPrompt(docs)
  const text = await callAnthropic({
    system: PROFILE_SYSTEM_PREAMBLE,
    postsText,
    sectionInstruction,
  })
  return text.trim()
}

function renderDocsForPrompt(docs: Document[]): string {
  return docs
    .map((d, i) => {
      const meta: string[] = [`# Post ${i + 1}: ${d.title}`]
      if (d.publishedAt) meta.push(`Published: ${d.publishedAt}`)
      if (d.author) meta.push(`Author: ${d.author}`)
      meta.push(`URL: ${d.sourceUrl}`)
      const body = d.contentMarkdown.slice(0, PER_POST_CHAR_CAP)
      return `${meta.join('\n')}\n\n${body}`
    })
    .join('\n\n---\n\n')
}

interface SectionCallArgs {
  system: string
  postsText: string
  sectionInstruction: string
}

type CallOnceResult =
  | { kind: 'ok'; text: string }
  | { kind: 'rate_limited'; error: Error }
  | { kind: 'fatal'; error: Error }

async function callAnthropic(args: SectionCallArgs): Promise<string> {
  // system + posts are invariant across the three section calls, so they go
  // into the sidecar's systemPrompt (the SDK caches that prefix → calls 2 and
  // 3 hit cache). The section instruction is the per-call user prompt, so its
  // variance sits outside the cached prefix.
  const systemPrompt = `${args.system}\n\n${args.postsText}`
  const prompt = args.sectionInstruction
  // Retry loop. On a rate limit we back off and try again — the OAuth-token
  // per-minute limit usually clears within a few seconds. Any other failure
  // surfaces immediately (no point retrying a 400/auth/etc). The sidecar/SDK
  // already retries transient 429s internally; this is the outer backstop.
  for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
    const result = await callSection(systemPrompt, prompt)
    if (result.kind === 'ok') return result.text
    if (result.kind === 'rate_limited' && attempt < MAX_RETRY_ATTEMPTS) {
      const delayMs = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)
      console.warn(
        `[profile] rate-limited, retrying in ${delayMs}ms (attempt ${attempt}/${MAX_RETRY_ATTEMPTS})`,
      )
      await sleep(delayMs)
      continue
    }
    throw result.error
  }
  // Loop exit only via throw above. Unreachable.
  throw new Error('exhausted retries')
}

// Sidecar event shapes for the one-shot title path — the same `claude:*`
// channel the chat runner and generateThreadTitle use. Assistant text arrives
// on `claude:event`; the run ends with `claude:done` (success) or
// `claude:error` (carrying a classified code).
interface SectionChatEvent {
  runId: string
  event: {
    type?: string
    message?: { content?: Array<{ type: string; text?: string }> }
  }
}
interface SectionDoneEvent {
  runId: string
}
interface SectionErrorEvent {
  runId: string
  code: string
  message: string
}

// Wall-clock cap on a single section call so a wedged stream can't hang the
// onboarding pipeline. Generous because the section prompt carries the full
// posts corpus; the SDK's own idle watchdog fires below this anyway.
const SECTION_TIMEOUT_MS = 90_000

/** Run one section prompt through the title sidecar (the SDK path) and collect
 * the assistant text. Mirrors generateThreadTitle's event plumbing, but
 * distinguishes a rate limit (retryable) from a fatal error so callAnthropic
 * can back off. */
function callSection(systemPrompt: string, prompt: string): Promise<CallOnceResult> {
  const runId = crypto.randomUUID()
  let text = ''
  const unlistens: UnlistenFn[] = []
  const cleanup = () => {
    while (unlistens.length > 0) {
      try {
        unlistens.pop()?.()
      } catch {
        // already detached
      }
    }
  }

  return new Promise<CallOnceResult>((resolve) => {
    let done = false
    const settle = (result: CallOnceResult) => {
      if (done) return
      done = true
      cleanup()
      resolve(result)
    }

    const timer = setTimeout(
      () => settle({ kind: 'fatal', error: new Error('section timed out') }),
      SECTION_TIMEOUT_MS,
    )

    Promise.all([
      listen<SectionChatEvent>('claude:event', (e) => {
        if (!parseChatEvent(e.payload) || e.payload.runId !== runId) return
        const ev = e.payload.event
        if (ev?.type !== 'assistant') return
        for (const b of ev.message?.content ?? []) {
          if (b.type === 'text' && typeof b.text === 'string') {
            text += b.text
          }
        }
      }),
      listen<SectionDoneEvent>('claude:done', (e) => {
        if (!parseDoneEvent(e.payload) || e.payload.runId !== runId) return
        clearTimeout(timer)
        if (!text.trim()) {
          settle({ kind: 'fatal', error: new Error('no text content in response') })
          return
        }
        settle({ kind: 'ok', text })
      }),
      listen<SectionErrorEvent>('claude:error', (e) => {
        if (!parseErrorEvent(e.payload) || e.payload.runId !== runId) return
        clearTimeout(timer)
        const code = e.payload.code
        if (code === 'RATE_LIMIT') {
          settle({
            kind: 'rate_limited',
            error: new Error(
              "We've hit Anthropic's rate limit. Wait about a minute and try again.",
            ),
          })
          return
        }
        settle({
          kind: 'fatal',
          error: new Error(e.payload.message || code || 'section failed'),
        })
      }),
    ])
      .then((registered) => {
        unlistens.push(...registered)
        return invoke('claude_title', {
          args: { runId, model: MODEL, systemPrompt, prompt },
        })
      })
      .catch((err) => {
        clearTimeout(timer)
        const message = typeof err === 'string' ? err : `invoke: ${String(err)}`
        settle({ kind: 'fatal', error: new Error(message) })
      })
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Assemble the wiki:profile markdown from the in-memory section
 * map produced by a single pipeline run. Other writers (ingest,
 * future agents, the user) recognise zones by their H2 heading —
 * see profile/markers.ts for the heading-name contract. */
function assembleMarkdownFromSections(
  sections: Partial<Record<ProfileSectionKey, string>>,
  docs: Document[],
): string {
  const ordered = SECTION_ORDER.flatMap((key) => {
    const content = sections[key]
    return content ? [{ kind: key, content }] : []
  })
  return assembleProfileMarkdown(
    ordered,
    docs.map((d) => ({ title: d.title, sourceUrl: d.sourceUrl })),
  )
}

async function writeWikiProfile(markdown: string): Promise<string | null> {
  const slug = await ensureProfileWikiSlug()
  if (!slug) return null
  // replaceDocBody (not seedDocBody) so a pipeline re-run actually
  // rewrites the page. seedDocBody no-ops on non-empty docs, which
  // is correct for first-create but would silently drop every
  // subsequent regeneration.
  const ok = await useDocsStore.getState().replaceDocBody(slug, markdown)
  return ok ? slug : null
}
