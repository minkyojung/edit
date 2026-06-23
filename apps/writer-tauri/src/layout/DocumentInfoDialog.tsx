// "Document info" dialog — surfaces stats that the live editor and
// catalog already track, so users have a single place to glance at
// size + creation date.
//
// Sources:
// - word/char count: docStatsStore, published live by the active CM editor
//   (whatever's currently in the doc, including unsaved keystrokes)
// - createdAt: KnownDoc.createdAt (the `.meta.json` sidecar). Phase
//   5b of the Yjs-removal migration moved this off the Y.Map and
//   onto the catalog; Phase 5c retired the Y.Map fallback the
//   dialog used to keep in place for not-yet-migrated docs (the
//   one-shot `migrateMetaV1` boot pass back-fills every legacy
//   sidecar, so the catalog reading is the only source now).
//
// The "AI activity" mark-counting section that used to live here was
// retired in Phase 6 of the Yjs-removal migration alongside the
// mark store / hooks the counts depended on. AI-edit visibility now
// flows through the gutter + Review panel.
//
// Read-only — no setters here. Recomputes on open via a single
// snapshot, so dialog stays cheap while the editor keeps streaming.

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useDocLabel } from '@/hooks/useDocLabel'
import { useActiveSlug } from '@/hooks/useActiveSlug'
import { useDocsStore } from '@/state/docsStore'
import { useDocStatsStore } from '@/state/docStatsStore'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function DocumentInfoDialog({ open, onOpenChange }: Props) {
  const activeSlug = useActiveSlug()
  const label = useDocLabel(activeSlug)
  const createdAt = useDocsStore((s) =>
    activeSlug ? s.knownDocs.find((d) => d.slug === activeSlug)?.createdAt : undefined,
  )
  const stats = useDocStatsStore((s) => s.stats)

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

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right tabular-nums text-foreground">{value}</dd>
    </>
  )
}

function fmtNum(n: number | undefined): string {
  if (n == null) return '—'
  return n.toLocaleString()
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
