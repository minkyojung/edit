// Banner inbox for wiki ingest proposals. The proposal content
// lives only in ingestStore until the user clicks Accept; on accept
// the content is parsed via Milkdown's parser and inserted at the
// end of the page as real PM blocks, then a `proofAuthored` mark
// is stamped through markStore so the provenance breadcrumb is
// queryable like any other domain Mark.
//
// Reject just removes the proposal from the queue — the page is
// untouched because the content was never in the PM tree.
//
// Phase 2.6 — migrated off direct `Y.Map('authoredMeta').set` +
// `tr.addMark(proofAuthored)` to `markStore.add({ kind: 'authored',
// anchor })`. The provenance metadata (sourceSlug / sourceLabel /
// sourceQuote / createdAt) now rides on the unified Mark instead
// of a sibling Y.Map. The PM dispatch (text insert) is still a
// separate transaction from markStore.add (mark stamp); the
// UndoManager's 500ms captureTimeout (MilkdownEditor.tsx:334) folds
// them into one undo step because they fire back-to-back in the
// same event handler.
//
// Mounted above MilkdownEditor in App.tsx's /notes route. Visible
// only when the active doc is a wiki:* page and pendingProposals
// has entries targeting that page's type.

import { useDocsStore, isUserOwnedWiki } from '@/state/docsStore'
import { useEditorViewStore } from '@/state/editorViewStore'
import { useIngestStore, type PendingProposal } from '@/state/ingestStore'
import { assembleProposalMarkdown } from '@/agent/ingest'
import { markStore } from '@/domain/markStoreInstance'
import type { EditorView } from '@milkdown/kit/prose/view'
import { IconCheck, IconX } from '@tabler/icons-react'
import { cn } from '@/lib/utils'
import { notify } from '@/lib/notify'
import { resolveWikilinksInMarkdown } from '@/lib/wikilinkResolve'
import { prepareMarkdownAppend } from '@/lib/markdownAppend'
import { regenerateAiSummaryForSlug } from '@/agent/generateAiSummary'

const AGENT_ID = 'ai:wiki-ingest'

/** Apply one proposal: parse its markdown into PM blocks, insert
 * at the end of the active wiki doc, then stamp `proofAuthored` on
 * the inserted range via markStore. Returns true on success. */
async function acceptProposal(
  slug: string,
  view: EditorView,
  proposal: PendingProposal,
): Promise<boolean> {
  // Differentiate "parser not mounted" from "parser ran but produced
  // empty content" by pre-checking parser presence here. The shared
  // prepareMarkdownAppend helper returns null for both cases without
  // distinguishing — both happen rarely enough that pushing the
  // distinction into the helper isn't worth it, but the user-facing
  // toasts (Reconnect vs "couldn't read content") are different.
  if (!useEditorViewStore.getState().parser) {
    notify.markEditorNotReady()
    return false
  }
  // Assemble the markdown from atomic (entity, bullets) fields. The
  // target case ("append to existing page") keeps the `### {entity}`
  // sub-heading so multiple ingest passes group cleanly. Resolve
  // [[Page Title]] tokens before parse — the LLM emits them verbatim
  // in bullets, and unless we rewrite to standard markdown link
  // syntax the parser produces literal `[[X]]` text. Unresolved
  // titles stay as literals so the user can fix typos manually.
  const assembled = assembleProposalMarkdown(proposal, { withEntityHeading: true })
  if (!assembled) {
    notify.markCantRead()
    return false
  }
  const content = resolveWikilinksInMarkdown(assembled)
  const prep = prepareMarkdownAppend(view, content)
  if (!prep) {
    notify.markCantRead()
    return false
  }

  // Step 1: insert the new blocks. The dispatch fires the PM
  // transaction (y-prosemirror lands it on the Yjs fragment with
  // ySyncPluginKey origin — tracked by the UndoManager).
  view.dispatch(prep.tr)

  // Step 2: read the live text under the inserted range and stamp
  // the authored mark. Reading after dispatch so prep.from/to map
  // against the now-final doc. The quote serves as the Mark's
  // anchor identity; for authored marks it doesn't drive drift
  // detection (authored doesn't have a stale state) but isValidMark
  // requires a non-empty quote.
  const quote = view.state.doc.textBetween(prep.from, prep.to, '\n')
  if (!quote.trim()) {
    // Parsed to non-text-only nodes (e.g. only a heading mark with
    // no text body). Stamping with an empty quote would fail
    // validation; surface as "couldn't read" rather than landing a
    // malformed mark.
    notify.markCantRead()
    return false
  }

  const result = await markStore.add({
    slug,
    kind: 'authored',
    quote,
    anchor: { from: prep.from, to: prep.to },
    by: AGENT_ID,
    sourceSlug: proposal.sourceSlug,
    sourceLabel: proposal.sourceLabel,
    sourceQuote: proposal.sourceQuote,
    // Wiki ingest doesn't carry per-proposal model info on
    // PendingProposal today — the ingest pipeline uses a single
    // INGEST_MODEL constant. If we later persist the actual model
    // used per pass, plumb it through here.
  })

  if (!result.ok) {
    console.error('[wiki-banner] markStore.add failed', result.reason)
    // The text is already in the doc — undo would be a hard rollback
    // the user didn't ask for. Surface the failure quietly and rely
    // on the user reading the breadcrumb-less content the same way
    // they would any manually-typed text.
    notify.markCantAdd()
  }

  return true
}

export function WikiPageBanner() {
  const activeSlug = useDocsStore((s) => s.activeSlug)
  const knownDocs = useDocsStore((s) => s.knownDocs)
  const handles = useDocsStore((s) => s.handles)
  const pendingProposals = useIngestStore((s) => s.pendingProposals)
  const remove = useIngestStore((s) => s.remove)
  const view = useEditorViewStore((s) => s.view)

  if (!activeSlug) return null
  const known = knownDocs.find(
    (d) => d.slug === activeSlug && !d.archivedAt,
  )
  // Banner shows on user wiki content only. system:* pages have
  // their own write pipelines (system:log uses useApplyPendingLogs,
  // system:index writes deterministically from state/wikiIndex.ts)
  // so they don't need an inbox — isUserOwnedWiki narrows to the
  // wiki:custom-* category and folds in the old "skip system:log"
  // guard naturally.
  if (!known || !isUserOwnedWiki(known)) return null

  const matching = pendingProposals.filter((p) => p.target === known.type)
  if (matching.length === 0) return null

  const handle = handles[activeSlug]

  const handleAccept = async (proposal: PendingProposal) => {
    if (!view || !handle) {
      notify.markEditorNotReady()
      return
    }
    const ok = await acceptProposal(activeSlug, view, proposal)
    if (ok) {
      remove({ proposalIds: [proposal.id] })
      // Body just changed — kick off a background summary refresh so
      // the Tier 1 catalog reflects the new content on the next
      // ingest pass. Fire-and-forget; the user-visible accept flow
      // is already complete by this point.
      void regenerateAiSummaryForSlug(activeSlug)
    }
  }
  const handleReject = (proposal: PendingProposal) => {
    remove({ proposalIds: [proposal.id] })
  }

  return (
    <div className="mx-auto mt-4 mb-6 max-w-prose rounded-lg border border-border bg-card/60 p-3">
      <div className="mb-2 text-sm font-medium text-foreground">
        검토할 제안 {matching.length}건
      </div>
      <ul className="flex flex-col gap-2">
        {matching.map((proposal) => (
          <ProposalCard
            key={proposal.id}
            proposal={proposal}
            onAccept={() => handleAccept(proposal)}
            onReject={() => handleReject(proposal)}
          />
        ))}
      </ul>
    </div>
  )
}

function ProposalCard({
  proposal,
  onAccept,
  onReject,
}: {
  proposal: PendingProposal
  onAccept: () => void
  onReject: () => void
}) {
  return (
    <li className="rounded border border-border/60 bg-background p-2">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="mb-1 text-[11px] text-muted-foreground">
            {proposal.sourceLabel}
          </div>
          {/* entity is the topic of the bullets — render as a small
              heading so the user reads "Sarah: <facts>" at a glance.
              Replaces the prior <pre>{proposal.content}</pre> dump,
              which leaked raw markdown (asterisks, hyphens) into the
              review surface. */}
          <div className="text-[13px] font-medium leading-snug text-foreground">
            {proposal.entity}
          </div>
          <ul className="mt-0.5 list-disc pl-4 text-[13px] leading-snug text-foreground">
            {proposal.bullets.map((bullet, i) => (
              <li key={i} className="break-words">
                {bullet}
              </li>
            ))}
          </ul>
          {proposal.sourceQuote && (
            <div className="mt-1 border-l-2 border-border/60 pl-2 text-[11.5px] italic leading-snug text-muted-foreground/80">
              “{proposal.sourceQuote}”
            </div>
          )}
        </div>
        <div className="flex flex-col gap-1">
          <button
            type="button"
            onClick={onAccept}
            aria-label="Accept"
            className={cn(
              'flex h-7 w-7 items-center justify-center rounded',
              'text-muted-foreground transition-colors',
              'hover:bg-accent hover:text-foreground',
              'outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
            )}
          >
            <IconCheck size={14} stroke={1.75} />
          </button>
          <button
            type="button"
            onClick={onReject}
            aria-label="Reject"
            className={cn(
              'flex h-7 w-7 items-center justify-center rounded',
              'text-muted-foreground transition-colors',
              'hover:bg-accent hover:text-foreground',
              'outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
            )}
          >
            <IconX size={14} stroke={1.75} />
          </button>
        </div>
      </div>
    </li>
  )
}
