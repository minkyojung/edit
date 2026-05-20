// URL → adapters → 3 LLM section calls → wiki:profile.
//
// One end-to-end function (runProfilePipeline) that the onboarding
// dialog drives. The dialog passes a progress callback so it can
// render "fetching" / "section_done" cards as the run advances.
//
// The pipeline writes wiki:profile exactly once at the end, after
// all three sections succeed. seedDocBody is one-shot (it skips
// when the page already has content), so we accumulate in memory
// and assemble the full markdown before the single write. This is
// also why a partial failure (Themes throws) aborts cleanly without
// leaving a half-written profile page behind.

import { invoke } from '@tauri-apps/api/core'
import { discoverAndFetch, type Document } from './adapters'
import {
  PROFILE_SECTIONS,
  PROFILE_SYSTEM_PREAMBLE,
  type ProfileSectionKey,
} from './conventions'
import { useDocsStore } from '@/state/docsStore'
import { ensureProfileWikiSlug } from '@/state/wikiService'

// Haiku for the section calls. The OAuth-token budget the app
// shares with chat/ingest/Claude Code itself is the real bottleneck
// (not per-minute rate limit), so cost-per-call matters. Haiku is
// ~3x cheaper than Sonnet and the Voice/Themes/About extraction is
// well within Haiku's competence — stylistic summarisation, not
// reasoning. If About quality regresses we can selectively promote
// it to Sonnet later.
const MODEL = 'claude-haiku-4-5'
const MAX_TOKENS_PER_SECTION = 800
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
  const { adapter, documents } = await discoverAndFetch(inputUrl)
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
  const markdown = assembleMarkdown(sections, documents)
  const slug = await writeWikiProfile(markdown)
  if (!slug) {
    return { ok: false, reason: 'write_failed' }
  }
  onProgress({ kind: 'done', slug })
  return { ok: true, slug }
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

  // Caching strategy: keep system + posts identical across all three
  // section calls so Anthropic's prompt cache hits on calls 2 and 3.
  // Section-specific instruction is appended AFTER the cache marker
  // on the posts block — anything before the marker is the cached
  // prefix; anything after re-runs each call.
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

interface AnthropicResult {
  status: number
  body: {
    content?: Array<{ type: string; text?: string }>
    error?: { type?: string; message?: string }
  }
}

/** Turn an Anthropic error block into a human-readable message.
 * The OAuth-token path often returns `message: "Error"` (literally
 * the string "Error") when rate-limited, with the real signal in
 * `type` (e.g. "rate_limit_error"). Prefer type when message is
 * empty / generic. */
function formatApiError(
  status: number,
  err: { type?: string; message?: string } | undefined,
): string {
  if (status === 429) {
    return "We've hit Anthropic's rate limit. Wait about a minute and try again."
  }
  const message = err?.message
  const meaningful = message && message !== 'Error' ? message : null
  if (meaningful) return meaningful
  if (err?.type) return `${err.type} (status ${status})`
  return `status ${status}`
}

interface SectionCallArgs {
  system: string
  postsText: string
  sectionInstruction: string
}

async function callAnthropic(args: SectionCallArgs): Promise<string> {
  // Retry loop. On 429 we back off and try again — the OAuth-token
  // per-minute limit usually clears within a few seconds. Any other
  // failure surfaces immediately (no point retrying a 400/auth/etc).
  for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
    const result = await callOnce(args)
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

type CallOnceResult =
  | { kind: 'ok'; text: string }
  | { kind: 'rate_limited'; error: Error }
  | { kind: 'fatal'; error: Error }

async function callOnce(args: SectionCallArgs): Promise<CallOnceResult> {
  let resp: AnthropicResult
  try {
    resp = await invoke<AnthropicResult>('anthropic_messages_create', {
      request: { body: buildRequestBody(args) },
    })
  } catch (err) {
    console.error('[profile] invoke failed', err)
    const message = typeof err === 'string' ? err : `invoke: ${String(err)}`
    return { kind: 'fatal', error: new Error(message) }
  }

  if (resp.status === 429) {
    console.warn('[profile] 429', { body: resp.body })
    return {
      kind: 'rate_limited',
      error: new Error(formatApiError(resp.status, resp.body.error)),
    }
  }
  if (resp.status !== 200) {
    console.error('[profile] non-200', { status: resp.status, body: resp.body })
    return {
      kind: 'fatal',
      error: new Error(formatApiError(resp.status, resp.body.error)),
    }
  }
  const textBlock = resp.body.content?.find((b) => b.type === 'text')
  if (!textBlock?.text) {
    console.error('[profile] no text block', { body: resp.body })
    return { kind: 'fatal', error: new Error('no text content in response') }
  }
  return { kind: 'ok', text: textBlock.text }
}

/** Build the Messages API body with a prompt-cache marker on the
 * posts block. The cache prefix is (system + posts) — identical
 * across the three section calls, so calls 2 and 3 hit the cache
 * and pay only for the (small) section instruction + output. The
 * section instruction sits AFTER the marker so its variance
 * doesn't invalidate the cache. */
function buildRequestBody(args: SectionCallArgs) {
  return {
    model: MODEL,
    max_tokens: MAX_TOKENS_PER_SECTION,
    system: args.system,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: args.postsText,
            cache_control: { type: 'ephemeral' },
          },
          { type: 'text', text: args.sectionInstruction },
        ],
      },
    ],
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function assembleMarkdown(
  sections: Partial<Record<ProfileSectionKey, string>>,
  docs: Document[],
): string {
  const parts: string[] = []
  for (const key of SECTION_ORDER) {
    const body = sections[key]
    if (!body) continue
    parts.push(`${PROFILE_SECTIONS[key].heading}\n\n${body}`)
  }
  parts.push('## Sources')
  parts.push(docs.map((d) => `- [${d.title}](${d.sourceUrl})`).join('\n'))
  return parts.join('\n\n') + '\n'
}

async function writeWikiProfile(markdown: string): Promise<string | null> {
  const slug = await ensureProfileWikiSlug()
  if (!slug) return null
  const ok = await useDocsStore.getState().seedDocBody(slug, markdown)
  return ok ? slug : null
}
