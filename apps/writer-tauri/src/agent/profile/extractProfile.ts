// URL list → ProfileFields, via two LLM passes:
//
//   1. Per-URL extraction (Haiku, parallel). Each source produces a
//      partial profile shaped like ProfileFields. Voice samples are
//      verbatim quotes; everything else may be inferred but should
//      be grounded in the source text.
//   2. Synthesis (Sonnet, one call). Receives all per-URL partials
//      plus their source labels, merges into a single coherent
//      ProfileFields, and writes the freeform `about` paragraph.
//
// Both passes use the same `submit_profile` relay tool on the
// sidecar. Distinct events would be cleaner, but using one tool +
// one event keeps the sidecar contract minimal — the host
// distinguishes pass type by which call site is waiting.
//
// Plausibility design: when a per-URL source is thin, the partial
// just leaves arrays empty. Synthesis tolerates sparse partials and
// fills `about` with whatever signal it can find, so the user gets
// a usable draft even from a single short blog post.

import { structuredCall } from '@/agent/anthropicDirect'
import { fetchUrlAsMarkdown, type FetchedSource } from './fetchUrl'
import { renderProfileMd } from './renderProfileMd'
import {
  EMPTY_PROFILE,
  type PartialProfile,
  type ProfileFields,
} from './profileTypes'

/** JSON Schema for the `submit_profile` tool — mirrors the sidecar's
 * zod schema but expressed in JSON Schema for the direct API call.
 * Kept inline here so the per-call shape stays self-documenting. */
const SUBMIT_PROFILE_TOOL = {
  name: 'submit_profile',
  description:
    'Submit a structured profile extracted from one or more sources about the user. Call exactly once per run.',
  schema: {
    type: 'object',
    properties: {
      name: { type: ['string', 'null'] },
      headline: { type: ['string', 'null'] },
      location: { type: ['string', 'null'] },
      roles: { type: 'array', items: { type: 'string' } },
      interests: { type: 'array', items: { type: 'string' } },
      voice_samples: { type: 'array', items: { type: 'string' } },
      values: { type: 'array', items: { type: 'string' } },
      dispositions: { type: 'array', items: { type: 'string' } },
      about: { type: 'string' },
    },
    required: [
      'name',
      'headline',
      'location',
      'roles',
      'interests',
      'voice_samples',
      'values',
      'dispositions',
      'about',
    ],
  } as const,
}

// Both passes use Sonnet. Originally per-URL was Haiku for cost,
// but Haiku 4.5 in tool-use mode routinely sandbags `submit_profile`
// — it generates "Profile extracted and submitted" as text and
// never invokes the tool, even with the strongest prompt language.
// Claude Agent SDK doesn't expose `toolChoice` so we can't force
// the call from the host side. Sonnet 4.6 follows tool-use
// instructions reliably; the ~$0.03 extra per profile bootstrap
// is negligible (Profile is a one-time operation per user).
const EXTRACT_MODEL = 'claude-sonnet-4-6'
const SYNTHESIS_MODEL = 'claude-sonnet-4-6'

/** Hard cap so a wildly long Substack archive doesn't blow the
 * Haiku context window. Empirically ~50KB of prose is plenty for
 * voice / disposition signal. */
const PER_SOURCE_MAX_CHARS = 50_000

export interface ExtractProfileProgress {
  urlsTotal: number
  urlsDone: number
  urlsFailed: number
  synthesisRunning: boolean
}

export interface ExtractProfileResult {
  profile: ProfileFields
  profileMarkdown: string
  sourcesProcessed: number
  sourcesFailed: number
}

export interface ExtractProfileOptions {
  onProgress?: (p: ExtractProfileProgress) => void
}

export async function extractProfile(
  urls: string[],
  opts: ExtractProfileOptions = {},
): Promise<ExtractProfileResult> {
  const cleaned = urls.map((u) => u.trim()).filter((u) => u.length > 0)
  if (cleaned.length === 0) {
    return {
      profile: EMPTY_PROFILE,
      profileMarkdown: '',
      sourcesProcessed: 0,
      sourcesFailed: 0,
    }
  }

  const progress: ExtractProfileProgress = {
    urlsTotal: cleaned.length,
    urlsDone: 0,
    urlsFailed: 0,
    synthesisRunning: false,
  }
  opts.onProgress?.({ ...progress })

  // Per-URL fan-out — fetch + extract in parallel. Each worker
  // emits progress on completion so the UI can stream a "3 / 5
  // sources" counter.
  const partials = await Promise.all(
    cleaned.map(async (url) => {
      try {
        const source = await fetchUrlAsMarkdown(url)
        if (!source) {
          progress.urlsFailed += 1
          progress.urlsDone += 1
          opts.onProgress?.({ ...progress })
          return null
        }
        const partial = await extractFromSource(source)
        progress.urlsDone += 1
        opts.onProgress?.({ ...progress })
        return partial
      } catch (err) {
        console.error('[profile:extract] per-URL failed', { url, err })
        progress.urlsFailed += 1
        progress.urlsDone += 1
        opts.onProgress?.({ ...progress })
        return null
      }
    }),
  )

  const validPartials = partials.filter(
    (p): p is PartialProfile => p !== null,
  )
  if (validPartials.length === 0) {
    return {
      profile: { ...EMPTY_PROFILE, source_urls: cleaned },
      profileMarkdown: '',
      sourcesProcessed: 0,
      sourcesFailed: progress.urlsFailed,
    }
  }

  // Synthesis — one call, merges across sources. Even with a single
  // partial this still runs to produce the `about` paragraph (the
  // per-URL pass leaves that field minimal).
  progress.synthesisRunning = true
  opts.onProgress?.({ ...progress })

  const synthesised = await synthesise(validPartials)
  const profile: ProfileFields = {
    ...synthesised,
    source_urls: validPartials.map((p) => p.source_url),
  }

  progress.synthesisRunning = false
  opts.onProgress?.({ ...progress })

  return {
    profile,
    profileMarkdown: renderProfileMd(profile),
    sourcesProcessed: validPartials.length,
    sourcesFailed: progress.urlsFailed,
  }
}

// ── Per-URL pass ───────────────────────────────────────────────────

const PER_URL_SYSTEM_PROMPT = `You are extracting a profile of a single person from one source they authored (a blog post, RSS feed, Twitter, etc.).

**You MUST call the submit_profile tool exactly once.** Do NOT respond with text describing what you would submit, or saying "I've extracted and submitted" — that text is discarded. Only the tool call lands. If you don't invoke submit_profile, your work is lost and the user sees an error.

Rules:
- voice_samples MUST be verbatim quotes (up to ~200 chars each) from the source text. Do not paraphrase, summarise, or invent.
- For dispositions and values: only emit if the source supports it. "first-principles thinker" is fine if they argue from primitives; "skeptical of hype" is fine if they push back on trends. If you cannot justify a trait from the text, omit it.
- Leave arrays empty rather than padding with vague entries.
- about: 1-2 sentences max for this single source. The synthesis step will write the full about paragraph across all sources.
- Use null for name / headline / location when not stated.

If the source text is too thin to extract anything (e.g. an error page or a paywall placeholder), still call submit_profile — pass empty arrays, null for nullable fields, and a one-sentence about explaining what you saw. Never respond with prose alone.`

async function extractFromSource(source: FetchedSource): Promise<PartialProfile | null> {
  const truncated =
    source.markdown.length > PER_SOURCE_MAX_CHARS
      ? source.markdown.slice(0, PER_SOURCE_MAX_CHARS) + '\n\n... [truncated]'
      : source.markdown
  const sourceLabel = source.title
    ? `${source.title} (${source.url})`
    : source.url
  const prompt = `Source: ${sourceLabel}\n\nText:\n\n${truncated}`

  const result = await structuredCall<ProfileFields>({
    model: EXTRACT_MODEL,
    systemPrompt: PER_URL_SYSTEM_PROMPT,
    prompt,
    toolName: SUBMIT_PROFILE_TOOL.name,
    toolDescription: SUBMIT_PROFILE_TOOL.description,
    toolSchema: SUBMIT_PROFILE_TOOL.schema,
  })
  if (!result) {
    console.warn('[profile:extract] per-URL extract returned null', {
      url: source.url,
    })
    return null
  }
  return {
    ...result,
    source_url: source.url,
    source_title: source.title,
  }
}

// ── Synthesis pass ─────────────────────────────────────────────────

const SYNTHESIS_SYSTEM_PROMPT = `You are merging multiple partial profiles (each extracted from one source the user authored) into a single coherent profile.

**You MUST call the submit_profile tool exactly once.** Do NOT respond with text describing what you would submit. Only the tool call lands; prose is discarded.

Rules:
- Preserve voice_samples verbatim from the partials. Pick the strongest 3-5 across all sources (varied length / topic). Do not invent new quotes.
- Merge facts. Resolve conflicts by preferring the more frequent claim across sources; when split, pick the more specific one. Note: a single source is not a conflict, just accept it.
- about: 2-3 sentences in third person describing the user. Should feel like reading a thoughtful one-paragraph bio. Plausibility over accuracy — make it feel right based on the partials, don't pad with generic platitudes.
- dispositions and values: at most 6 each. Promote traits that show up across multiple sources; drop one-offs unless they're particularly strong.
- interests: up to 8. These are the topics they write about / care about.
- If a per-URL partial left a field empty, that's a signal — don't fabricate.`

async function synthesise(partials: PartialProfile[]): Promise<ProfileFields> {
  const block = partials
    .map((p, i) => {
      const label = p.source_title ? `${p.source_title} (${p.source_url})` : p.source_url
      return [
        `### Source ${i + 1} — ${label}`,
        `name: ${p.name ?? '(none)'}`,
        `headline: ${p.headline ?? '(none)'}`,
        `location: ${p.location ?? '(none)'}`,
        `roles: ${p.roles.join(', ') || '(none)'}`,
        `interests: ${p.interests.join(', ') || '(none)'}`,
        `voice_samples:\n${p.voice_samples.map((q) => `  > ${q}`).join('\n') || '  (none)'}`,
        `values: ${p.values.join(', ') || '(none)'}`,
        `dispositions: ${p.dispositions.join(', ') || '(none)'}`,
        `about (this source only): ${p.about || '(empty)'}`,
      ].join('\n')
    })
    .join('\n\n')

  const prompt = `Per-source partials:\n\n${block}\n\nMerge into one Profile via submit_profile.`

  const result = await structuredCall<ProfileFields>({
    model: SYNTHESIS_MODEL,
    systemPrompt: SYNTHESIS_SYSTEM_PROMPT,
    prompt,
    toolName: SUBMIT_PROFILE_TOOL.name,
    toolDescription: SUBMIT_PROFILE_TOOL.description,
    toolSchema: SUBMIT_PROFILE_TOOL.schema,
  })
  if (!result) {
    console.warn('[profile:extract] synthesis returned null')
    // Fallback: just merge naively across partials so the user gets
    // *something*. Voice samples / dispositions union; about uses
    // the longest per-source about.
    return naiveFallbackMerge(partials)
  }
  return { ...result, source_urls: partials.map((p) => p.source_url) }
}

function naiveFallbackMerge(partials: PartialProfile[]): ProfileFields {
  const merged: ProfileFields = { ...EMPTY_PROFILE, source_urls: partials.map((p) => p.source_url) }
  const uniq = (arr: string[]) => Array.from(new Set(arr.filter((s) => s.trim().length > 0)))
  for (const p of partials) {
    merged.name ??= p.name
    merged.headline ??= p.headline
    merged.location ??= p.location
    merged.roles = uniq([...merged.roles, ...p.roles])
    merged.interests = uniq([...merged.interests, ...p.interests])
    merged.voice_samples = uniq([...merged.voice_samples, ...p.voice_samples])
    merged.values = uniq([...merged.values, ...p.values])
    merged.dispositions = uniq([...merged.dispositions, ...p.dispositions])
  }
  // about: longest non-empty per-source about as a fallback.
  const longestAbout = partials
    .map((p) => p.about)
    .filter((s) => s.trim().length > 0)
    .sort((a, b) => b.length - a.length)[0]
  if (longestAbout) merged.about = longestAbout
  return merged
}

// Dev handle — exercise the full URL → profile path from DevTools.
//   await window.__extractProfile(['https://blog.example.com'])
if (import.meta.env.DEV) {
  ;(window as unknown as { __extractProfile: typeof extractProfile }).__extractProfile =
    extractProfile
}
