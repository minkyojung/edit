// Banner inbox for wiki ingest proposals — replaces the old
// "stamp proofSuggestion mark on the last word of the page" surface
// (see applyIngest.ts pre-2026-05-13). The proposal content lives
// only in ingestStore until the user clicks Accept; on accept the
// content is parsed via Milkdown's parser and inserted at the end
// of the page as real PM blocks, and proofAuthored is stamped on
// the inserted range so the breadcrumb survives (rich metadata
// rides on Y.Map('authoredMeta'), matching the markActions.ts
// acceptMark(insert) pattern).
//
// Reject just removes the proposal from the queue — the page is
// untouched because the content was never in the PM tree.
//
// Mounted above MilkdownEditor in App.tsx's /notes route. Visible
// only when the active doc is a wiki:* page and pendingProposals
// has entries targeting that page's type.

import { useDocsStore } from '@/state/docsStore'
import { useEditorViewStore } from '@/state/editorViewStore'
import { useIngestStore, type PendingProposal } from '@/state/ingestStore'
import type { AuthoredMeta } from '@/hooks/useCollabDoc'
import type { EditorView } from '@milkdown/kit/prose/view'
import type * as Y from 'yjs'
import { IconCheck, IconX } from '@tabler/icons-react'
import { cn } from '@/lib/utils'
import { notify } from '@/lib/notify'
import { resolveWikilinksInMarkdown } from '@/lib/wikilinkResolve'

const AGENT_ID = 'ai:wiki-ingest'

/** Apply one proposal: parse its markdown content into PM blocks,
 * insert at the end of the active wiki doc, stamp proofAuthored on
 * the inserted range, and record the source breadcrumb in
 * Y.Map('authoredMeta'). Returns true on success. */
function acceptProposal(
  view: EditorView,
  ydoc: Y.Doc,
  proposal: PendingProposal,
): boolean {
  const parser = useEditorViewStore.getState().parser
  if (!parser) {
    notify.markEditorNotReady()
    return false
  }
  // Resolve [[Page Title]] tokens before parse — the LLM emits them
  // verbatim in content, and unless we rewrite to standard markdown
  // link syntax the parser produces literal `[[X]]` text. Unresolved
  // titles stay as literals so the user can fix typos manually.
  const content = resolveWikilinksInMarkdown(proposal.content)
  const parsed = parser(content)
  if (!parsed || parsed.content.size === 0) {
    notify.markCantRead()
    return false
  }

  const tr = view.state.tr
  const insertPos = view.state.doc.content.size
  const fragmentSize = parsed.content.size
  tr.insert(insertPos, parsed.content)

  // Stamp proofAuthored on the inserted range. Same pattern as
  // markActions.acceptMark(insert): the inline mark anchors the
  // breadcrumb (server canonicalizes it cleanly), rich metadata
  // lives in Y.Map('authoredMeta') which the server treats as
  // opaque binary so drift detection can't fire on it.
  const markId = crypto.randomUUID()
  const authoredType = view.state.schema.marks.proofAuthored
  if (authoredType) {
    tr.addMark(
      insertPos,
      insertPos + fragmentSize,
      authoredType.create({ id: markId, by: AGENT_ID }),
    )
  }

  // Single Yjs transact wraps dispatch + Y.Map write so Cmd+Z
  // restores the page text, the authored mark, and the meta entry
  // atomically. 'mark-action' origin matches the trackedOrigins
  // configured on Y.UndoManager (see MilkdownEditor.tsx).
  ydoc.transact(() => {
    view.dispatch(tr)
    const meta: AuthoredMeta = {
      sourceSlug: proposal.sourceSlug,
      sourceLabel: proposal.sourceLabel,
      sourceQuote: proposal.sourceQuote,
      createdAt: new Date(proposal.proposedAt).toISOString(),
      acceptedAt: new Date().toISOString(),
    }
    ydoc.getMap<AuthoredMeta>('authoredMeta').set(markId, meta)
  }, 'mark-action')

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
  if (!known || !known.type.startsWith('wiki:')) return null

  // wiki:log drains pending log entries via useApplyPendingLogs;
  // there are no "proposals" to review for the log page itself.
  if (known.type === 'wiki:log') return null

  const matching = pendingProposals.filter((p) => p.target === known.type)
  if (matching.length === 0) return null

  const handle = handles[activeSlug]

  const handleAccept = (proposal: PendingProposal) => {
    if (!view || !handle) {
      notify.markEditorNotReady()
      return
    }
    const ok = acceptProposal(view, handle.ydoc, proposal)
    if (ok) remove({ proposalIds: [proposal.id] })
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
          <pre className="whitespace-pre-wrap break-words font-sans text-[13px] leading-snug text-foreground">
            {proposal.content}
          </pre>
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
