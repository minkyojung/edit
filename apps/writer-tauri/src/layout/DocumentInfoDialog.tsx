// "Document info" dialog — surfaces stats that the live editor and
// ydoc already track, so users have a single place to glance at
// authorship + size.
//
// Sources:
// - word/char count: editorView.state.doc.textBetween (whatever's
//   currently rendered, including unsaved keystrokes)
// - mark counts: ydoc.getMap('marks'), populated by applyProposal
//   when the AI proposes via writer-relay
// - ai-co-authored ratio: char-length sum of accepted suggestion
//   marks / total chars. Underestimates true AI involvement (any AI
//   text the user pastes manually has no mark), but represents the
//   tracked floor.
// - createdAt: from ydoc.getMap('meta')
//
// Read-only — no setters here. Recomputes on open via a single
// snapshot, so dialog stays cheap while the editor keeps streaming.

import { useEffect, useMemo, useState } from 'react'
import * as Y from 'yjs'
import type { EditorView } from '@milkdown/kit/prose/view'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useDocLabel } from '@/hooks/useDocLabel'
import { readDocMeta } from '@/hooks/useDocMeta'
import { useActiveSlug } from '@/hooks/useActiveSlug'
import { useDocsStore } from '@/state/docsStore'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  ydoc: Y.Doc | null
  editorView: EditorView | null
}

interface Stats {
  words: number
  chars: number
  pendingSuggestions: number
  acceptedSuggestions: number
  rejectedSuggestions: number
  comments: number
  aiCharsApprox: number
}

interface StoredMark {
  kind: 'insert' | 'delete' | 'replace' | 'comment'
  by: string
  quote: string
  status?: 'pending' | 'accepted' | 'rejected'
  content?: string | null
  at: string
}

export function DocumentInfoDialog({ open, onOpenChange, ydoc, editorView }: Props) {
  const activeSlug = useActiveSlug()
  const label = useDocLabel(activeSlug)
  // Phase 5b of the Yjs-removal migration: createdAt now lives on the
  // catalog (`.meta.json` sidecar via `KnownDoc.createdAt`). Fall back
  // to the Y.Map read for legacy docs whose sidecar hasn't been
  // migrated yet (the migration is sentinel-gated and idempotent —
  // post-boot every doc should have its createdAt on the catalog).
  const knownCreatedAt = useDocsStore((s) =>
    activeSlug ? s.knownDocs.find((d) => d.slug === activeSlug)?.createdAt : undefined,
  )
  const meta = useMemo(() => (ydoc ? readDocMeta(ydoc) : null), [ydoc, open])
  const createdAt = knownCreatedAt ?? meta?.createdAt

  // Snapshot stats when the dialog opens. Don't subscribe — these are
  // a glance-and-close kind of fact, and live updates would compete
  // with the editor for cycles for no real benefit.
  const [stats, setStats] = useState<Stats | null>(null)
  useEffect(() => {
    if (!open) return
    setStats(computeStats(ydoc, editorView))
  }, [open, ydoc, editorView])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="truncate">{label}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <Section title="Size">
            <Row label="Words" value={fmtNum(stats?.words)} />
            <Row label="Characters" value={fmtNum(stats?.chars)} />
          </Section>

          <Section title="AI activity">
            <Row
              label="AI-co-authored"
              value={fmtRatio(stats?.aiCharsApprox, stats?.chars)}
              hint="Counts only accepted suggestion marks. Manual paste-ins from chat aren't tracked."
            />
            <Row label="Pending suggestions" value={fmtNum(stats?.pendingSuggestions)} />
            <Row label="Accepted" value={fmtNum(stats?.acceptedSuggestions)} />
            <Row label="Rejected" value={fmtNum(stats?.rejectedSuggestions)} />
            <Row label="Comments" value={fmtNum(stats?.comments)} />
          </Section>

          <Section title="Created">
            <Row label="Date" value={createdAt ? fmtDate(createdAt) : '—'} />
          </Section>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground/80">
        {title}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">{children}</dl>
    </div>
  )
}

function Row({
  label,
  value,
  hint,
}: {
  label: string
  value: string
  hint?: string
}) {
  return (
    <>
      <dt className="text-muted-foreground" title={hint}>
        {label}
      </dt>
      <dd className="text-right tabular-nums text-foreground">{value}</dd>
    </>
  )
}

function fmtNum(n: number | undefined): string {
  if (n == null) return '—'
  return n.toLocaleString()
}

function fmtRatio(part: number | undefined, whole: number | undefined): string {
  if (part == null || whole == null || whole === 0) return '—'
  const pct = Math.round((part / whole) * 100)
  return `${pct}%`
}

function fmtDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function computeStats(ydoc: Y.Doc | null, view: EditorView | null): Stats {
  const empty: Stats = {
    words: 0,
    chars: 0,
    pendingSuggestions: 0,
    acceptedSuggestions: 0,
    rejectedSuggestions: 0,
    comments: 0,
    aiCharsApprox: 0,
  }
  if (!view) return empty

  const text = view.state.doc.textBetween(0, view.state.doc.content.size, '\n', '\n')
  const chars = text.length
  const words = text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length

  let pending = 0
  let accepted = 0
  let rejected = 0
  let comments = 0
  let aiChars = 0

  if (ydoc) {
    const marks = ydoc.getMap<StoredMark>('marks')
    marks.forEach((m) => {
      if (m.kind === 'comment') {
        comments += 1
        return
      }
      const status = m.status ?? 'pending'
      if (status === 'accepted') {
        accepted += 1
        // Quote length is a reasonable approximation of the
        // suggestion's footprint — for replace/insert marks it's
        // what the AI authored or replaced. Not exact for delete
        // (the AI removed those chars), but close enough.
        aiChars += m.quote?.length ?? 0
      } else if (status === 'rejected') {
        rejected += 1
      } else {
        pending += 1
      }
    })
  }

  return {
    words,
    chars,
    pendingSuggestions: pending,
    acceptedSuggestions: accepted,
    rejectedSuggestions: rejected,
    comments,
    aiCharsApprox: aiChars,
  }
}
