// Generates an 80-char one-line summary of a wiki page body and
// persists it in the doc's sidecar so the Tier 1 catalog
// (state/wikiIndex.ts) can show meaningful summaries instead of
// the "first non-empty body line" fallback.
//
// Trigger sites:
//   - createCustomWikiPage (wikiService.ts) — new wiki page seeded
//     with content from an ingest proposal; first summary.
//   - WikiPageBanner accept — user accepted a proposal that
//     appended content; summary may be stale, regenerate.
//
// Fire-and-forget from those call sites: failures (auth, network,
// timeout) just leave the existing sidecar field alone. The
// catalog still works via its fallback (`bodyExcerpt`); a stale
// summary is a quality issue, not a correctness one.
//
// The LLM call uses the same `claude_title` sidecar path as the
// thread-title generator — single-shot, no streaming, no tool
// relay. Haiku model, ~50 token cap is plenty.

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { readWikiMarkdown } from '@/state/wikiService'
import { useDocsStore } from '@/state/docsStore'
import { pathForDoc } from '@/lib/docPaths'
import { updateVaultIndex } from '@/lib/vaultIndex'
import { invalidateWikiIndex } from '@/state/wikiIndex'

const MODEL = 'claude-haiku-4-5'
const TIMEOUT_MS = 10_000
const SUMMARY_MAX_LEN = 80

const SYSTEM = `Summarize this wiki page in ONE sentence in the SAME LANGUAGE as the body.

Rules:
- Output ONLY the summary text. No quotes, no prefix like "Summary:".
- Describe what the page is ABOUT (the entity / concept / project), not what most recently changed.
- Capture the single most defining fact. A person → their role; a project → its purpose; a concept → its core idea.
- Under 80 characters. Trim less-essential nuance to fit.`

interface ChatEvent {
  runId: string
  event: {
    type?: string
    message?: { content?: Array<{ type: string; text?: string }> }
  }
}

interface DoneEvent {
  runId: string
}

interface ErrorEvent {
  runId: string
  code: string
  message: string
}

/** Call the title sidecar with a "summarize this wiki page" prompt.
 * Returns the trimmed assistant text or null on any failure. */
async function callSummarizer(body: string): Promise<string | null> {
  const trimmed = body.trim()
  if (!trimmed) return null

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

  return new Promise<string | null>((resolve) => {
    let done = false
    const settle = (val: string | null) => {
      if (done) return
      done = true
      cleanup()
      resolve(val)
    }

    const timer = setTimeout(() => settle(null), TIMEOUT_MS)

    Promise.all([
      listen<ChatEvent>('claude:event', (e) => {
        if (e.payload.runId !== runId) return
        const ev = e.payload.event
        if (ev?.type !== 'assistant') return
        for (const b of ev.message?.content ?? []) {
          if (b.type === 'text' && typeof b.text === 'string') {
            text += b.text
          }
        }
      }),
      listen<DoneEvent>('claude:done', (e) => {
        if (e.payload.runId !== runId) return
        clearTimeout(timer)
        const cleaned = text
          .trim()
          .replace(/^["'`]|["'`]$/g, '')
          .replace(/^Summary:\s*/i, '')
        if (!cleaned) return settle(null)
        const truncated =
          cleaned.length > SUMMARY_MAX_LEN
            ? cleaned.slice(0, SUMMARY_MAX_LEN).trimEnd() + '…'
            : cleaned
        settle(truncated)
      }),
      listen<ErrorEvent>('claude:error', (e) => {
        if (e.payload.runId !== runId) return
        clearTimeout(timer)
        settle(null)
      }),
    ])
      .then((registered) => {
        unlistens.push(...registered)
        return invoke('claude_title', {
          args: { runId, model: MODEL, systemPrompt: SYSTEM, prompt: trimmed },
        })
      })
      .catch((err) => {
        console.warn('[aiSummary] invoke failed', err)
        clearTimeout(timer)
        settle(null)
      })
  })
}

/** Persist the summary as app-private soft state in `.octave/index.json`,
 * keyed by the doc's vault-relative path. `updateVaultIndex` merges just
 * the `aiSummary` field (leaving slug/archive/importance intact) and is
 * serialized against the flush's own index writes, so there's no
 * read-modify-write race. Silently returns when the doc has no resolvable
 * path (archived between trigger and write, vault unmounted, etc.). */
async function writeAiSummary(slug: string, summary: string): Promise<void> {
  const doc = useDocsStore.getState().knownDocs.find((d) => d.slug === slug)
  if (!doc) return
  const path = pathForDoc(doc)
  if (!path) return
  await updateVaultIndex(path, { slug: doc.slug, aiSummary: summary })
}

/** Public entry: read the doc's current body (in-memory PM state),
 * generate a one-line summary via the title sidecar, persist into
 * the .meta.json sidecar, and invalidate the Tier 1 wiki index so
 * the new summary surfaces on the next getWikiIndex() call.
 *
 * Fire-and-forget: any failure (no body, sidecar LLM down, vault
 * unmounted) leaves the existing sidecar field untouched. Callers
 * don't await this — it runs as a background side effect. */
export async function regenerateAiSummaryForSlug(slug: string): Promise<void> {
  const body = readWikiMarkdown(slug)
  if (!body) return
  const summary = await callSummarizer(body)
  if (!summary) return
  try {
    await writeAiSummary(slug, summary)
    invalidateWikiIndex()
    console.log('[aiSummary] regenerated', { slug, summary })
  } catch (err) {
    console.warn('[aiSummary] write failed', { slug, err })
  }
}
