// Keep/Reject tray for proposed skills (Phase 2B). Sits above the chat
// input next to ReviewTray; hides when empty. Reads the dedicated
// skillProposalStore (skills aren't wiki docs, so they don't flow through
// pendingChangesStore / ReviewTray). Keep writes the SKILL.md; the agent
// picks it up on the next session.

import { useSkillProposalStore } from '@/state/skillProposalStore'

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
        <div
          key={p.pendingId}
          className="rounded-lg border border-border bg-card px-3 py-2.5 text-[13px]"
        >
          <div className="mb-1 flex items-center gap-2">
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              skill
            </span>
            <span className="font-semibold text-foreground">{p.name}</span>
          </div>
          <p className="mb-2 line-clamp-2 text-muted-foreground">{p.description}</p>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded-md border border-border px-2.5 py-1 text-[12px] font-medium hover:bg-accent"
              onClick={() => void accept(p.pendingId)}
            >
              Keep
            </button>
            <button
              type="button"
              className="rounded-md border border-border px-2.5 py-1 text-[12px] text-muted-foreground hover:bg-accent"
              onClick={() => reject(p.pendingId)}
            >
              Reject
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
