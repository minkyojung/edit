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

const MODEL = 'claude-sonnet-4-6'
const MAX_TOKENS_PER_SECTION = 800
// Per-post truncation before the prompt. 4000 chars × ~20 posts =
// ~80k chars, well inside the model context after system prompt.
const PER_POST_CHAR_CAP = 4000

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
      const msg = err instanceof Error ? err.message : String(err)
      onProgress({ kind: 'error', message: `${key}: ${msg}` })
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
  const system = [
    PROFILE_SYSTEM_PREAMBLE,
    '',
    def.instruction,
    '',
    `Return ONLY the section body. Do not include the "${def.heading}" heading — the caller will add it.`,
  ].join('\n')

  const userContent = renderDocsForPrompt(docs)
  const text = await callAnthropic(system, userContent)
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
    error?: { message?: string }
  }
}

async function callAnthropic(
  system: string,
  userContent: string,
): Promise<string> {
  const resp = await invoke<AnthropicResult>('anthropic_messages_create', {
    request: {
      body: {
        model: MODEL,
        max_tokens: MAX_TOKENS_PER_SECTION,
        system,
        messages: [{ role: 'user', content: userContent }],
      },
    },
  })

  if (resp.status !== 200) {
    const reason = resp.body.error?.message ?? `status ${resp.status}`
    throw new Error(reason)
  }
  const textBlock = resp.body.content?.find((b) => b.type === 'text')
  if (!textBlock?.text) {
    throw new Error('no text content in response')
  }
  return textBlock.text
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
