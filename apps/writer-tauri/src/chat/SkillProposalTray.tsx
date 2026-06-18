// Keep/Reject tray for proposed skills (Phase 2B). Sits above the chat
// input next to ReviewTray; hides when empty. Reads the dedicated
// skillProposalStore (skills aren't wiki docs, so they don't flow through
// pendingChangesStore / ReviewTray). Keep writes the SKILL.md; the agent
// picks it up on the next session.
//
// When a proposal is an UPDATE (revising an existing skill), it renders the
// before→after with the SAME DiffBlock the editor / Review surfaces use — so
// a skill revision reads exactly like an AI doc edit. New skills show their
// body as a plain preview (no "before" to diff against).

import { useEffect, useState } from 'react'
import { useSkillProposalStore, skillDirName, type SkillProposal } from '@/state/skillProposalStore'
import { readSkillBody } from '@/lib/skillsLib'
import { diffPairsToLines } from '@/lib/pendingDiff'
import { DiffBlock } from '@/components/DiffBlock'
import type { DiffLine } from '@/lib/git'

export function SkillProposalTray() {
  // Select the stable map; derive the pending list in render (a selector
  // returning a fresh array each call would thrash zustand's equality check).
  const byId = useSkillProposalStore((s) => s.byId)
  const accept = useSkillProposalStore((s) => s.accept)
  const reject = useSkillProposalStore((s) => s.reject)
  const pending = Object.values(byId).filter((p) => p.status === 'pending')
  if (pending.length === 0) return null

  return (
    <div className="mx-4 mb-2 flex flex-col gap-2">
      {pending.map((p) => (
        <SkillProposalCard
          key={p.pendingId}
          proposal={p}
          onKeep={() => void accept(p.pendingId)}
          onReject={() => reject(p.pendingId)}
        />
      ))}
    </div>
  )
}

function SkillProposalCard({
  proposal: p,
  onKeep,
  onReject,
}: {
  proposal: SkillProposal
  onKeep: () => void
  onReject: () => void
}) {
  const isUpdate = !!p.updates
  // For an update, load the on-disk body and diff it against the proposed
  // body. null while loading / when there's nothing to show.
  const [diff, setDiff] = useState<DiffLine[] | null>(null)
  useEffect(() => {
    if (!isUpdate) {
      setDiff(null)
      return
    }
    let live = true
    readSkillBody(skillDirName(p.updates as string)).then((oldBody) => {
      if (!live) return
      setDiff(diffPairsToLines([{ before: oldBody, after: p.body }]))
    })
    return () => {
      live = false
    }
  }, [isUpdate, p.updates, p.body])

  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2.5 text-[13px]">
      <div className="mb-1 flex items-center gap-2">
        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
          {isUpdate ? 'update' : 'skill'}
        </span>
        <span className="font-semibold text-foreground">{p.name}</span>
      </div>
      <p className="mb-2 line-clamp-2 text-muted-foreground">{p.description}</p>

      {isUpdate ? (
        diff && diff.length > 0 ? (
          // Cap the diff height + scroll — without this a long skill diff makes
          // the absolutely-positioned chat footer grow past the panel, pushing
          // the input off-screen and breaking transcript scroll. Mirrors the
          // NEW branch's max-h-40 below.
          <div className="mb-2 max-h-40 overflow-y-auto">
            <DiffBlock lines={diff} />
          </div>
        ) : null
      ) : (
        <pre className="mb-2 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-background p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
          {p.body}
        </pre>
      )}

      {/* Reject (left) → Keep (right) with the shared pending-edit button
          styles, so the skill card matches the ReviewTray doc-edit cards
          it sits beside. */}
      <div className="flex items-center gap-1">
        <button
          type="button"
          className="pending-edit__action pending-edit__action--reject"
          onClick={onReject}
        >
          Reject
        </button>
        <button
          type="button"
          className="pending-edit__action pending-edit__action--keep"
          onClick={onKeep}
        >
          Keep
        </button>
      </div>
    </div>
  )
}
