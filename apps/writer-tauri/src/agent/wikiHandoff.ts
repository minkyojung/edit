// Chat → wiki handoff. The "feedback" half of Karpathy's bidirectional
// loop: a chat reply (or user statement) gets routed through the same
// ingest engine the daily pass uses, and any durable facts the model
// surfaces land in the existing review queue.
//
// Invoked from the assistant message UI when the user explicitly says
// "file this into the wiki" — never automatic. Manual gating is the
// signal-to-noise lever; daily-style passes are too eager for casual
// chat. See docs/refactor-proof-sdk-removal/06-wiki-completion.md and
// the plan at ~/.claude/plans/starry-booping-turing.md for the
// rationale (Option A — manual trigger).
//
// Reuses `runIngestCore` verbatim. The `chat:` prefix on `sourceLabel`
// is the only signal the engine needs — `buildPrompt` branches on it
// to tighten extraction (chat replies mix the user's direct statements
// with the assistant's narrative; the daily-tone prompt over-extracts
// otherwise). No new tool, no new prompt, no new banner UI.

import { runIngestCore } from '@/agent/ingest/index'
import {
  appendMarkdownToWikiPage,
  buildIngestCommitBody,
  type AppliedProposalForCommit,
} from '@/agent/applyIngest'
import { useDocsStore } from '@/state/docsStore'
import { useGitStore } from '@/state/gitStore'
import { flushDirty } from '@/lib/docFileSync'

export interface ChatHandoffArgs {
  /** Assistant or user message body to extract facts from. Empty /
   * whitespace-only inputs short-circuit with `enqueued: 0`. */
  messageContent: string
  /** Thread id — used as `sourceSlug` so the inbox groups by
   * originating thread, the same way daily passes group by note slug. */
  threadId: string
  /** Thread title — surfaces in banner cards as `chat: <title>`. Falls
   * back to `Untitled thread` when blank. */
  threadTitle: string
}

export interface ChatHandoffResult {
  /** Count of wiki proposals enqueued for review. Zero is a normal
   * outcome — the model judged the message had nothing durable. */
  enqueued: number
  /** Deduped routing keys for proposals that landed: a `wiki:*` type
   * id for appends, or `new:<name>` for `suggestNewPage` proposals.
   * Useful for the toast ("queued 2 — review on Sarah, Tom"). */
  affectedTargets: string[]
  /** True when the model emitted text but didn't call the structured
   * tool. Caller can show a soft warning rather than treating as
   * silent success. */
  malformed: boolean
}

/** Hand a chat message off to the ingest engine and enqueue any
 * resulting wiki proposals into the standard review queue. The
 * returned shape is meant to drive a toast / inline confirmation —
 * the actual review happens later when the user opens the affected
 * wiki page and the banner surfaces the cards.
 *
 * No-throw contract: transport / SDK errors propagate (callers can
 * surface them), but a malformed model response resolves with
 * `malformed: true` rather than rejecting. Empty inputs resolve with
 * a zero result. */
export async function runChatToWikiHandoff(
  args: ChatHandoffArgs,
): Promise<ChatHandoffResult> {
  const trimmed = args.messageContent.trim()
  if (!trimmed) {
    return { enqueued: 0, affectedTargets: [], malformed: false }
  }

  const label = `chat: ${args.threadTitle.trim() || 'Untitled thread'}`
  const core = await runIngestCore({ text: trimmed, sourceLabel: label })

  if (core.malformed) {
    return { enqueued: 0, affectedTargets: [], malformed: true }
  }
  if (core.proposals.length === 0 && !core.logEntry) {
    return { enqueued: 0, affectedTargets: [], malformed: false }
  }

  // Phase 2.A — same direct-write path as runIngestForSlug. Chat
  // handoff is just another ingest source; the only difference is
  // that suggestNewPage proposals from chat aren't materialized into
  // wiki pages here (runIngestCore doesn't run materializeNewPageProposals).
  // For Phase 2.A we restrict chat handoff to proposals that target
  // an EXISTING page — new-page suggestions from chat fall to the
  // user as a toast hint rather than auto-creating a page. (We can
  // wire materialize in later if it becomes a common ask.)
  const applied: AppliedProposalForCommit[] = []
  const targetSet = new Set<string>()
  const unresolvedNewPages: string[] = []
  for (const p of core.proposals) {
    if (p.target) {
      const targetDoc = useDocsStore
        .getState()
        .knownDocs.find((d) => d.type === p.target && !d.archivedAt)
      if (!targetDoc) {
        console.warn('[wikiHandoff] target type not in catalog', p.target)
        continue
      }
      // Phase G: the LLM's markdownToAppend is the final shape; no
      // host-side assembly. Empty / whitespace-only proposals are
      // dropped because they'd add nothing to the page.
      const md = p.markdownToAppend.trim()
      if (!md) continue
      const ok = await appendMarkdownToWikiPage(targetDoc.slug, md)
      if (ok) {
        applied.push({
          targetTitle: targetDoc.title?.trim() || targetDoc.slug,
          proposal: p,
        })
        targetSet.add(p.target)
      }
    } else if (p.suggestNewPage) {
      unresolvedNewPages.push(p.suggestNewPage)
      targetSet.add(`new:${p.suggestNewPage}`)
    }
  }


  if (applied.length > 0) {
    await flushDirty()
    const subject = `ai-edit: ${label} (${applied.length} page update${applied.length === 1 ? '' : 's'})`
    const body = buildIngestCommitBody(applied, label)
    const message = body ? `${subject}\n\n${body}` : subject
    await useGitStore.getState().commitChangesNow(message)
  }

  return {
    enqueued: applied.length,
    affectedTargets: Array.from(targetSet),
    malformed: false,
  }
}
