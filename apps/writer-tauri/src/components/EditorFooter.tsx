// Thin status footer pinned to the bottom of the editor area.
//
// Two states, mutually exclusive, both rendered as a single muted
// line:
//
//   Default — no mark under the cursor. Shows the AI-vs-human writing
//             ratio for the active doc (computed from proofProvenance
//             coverage). Stable, glanceable; the kind of always-on
//             stat you'd see in an IDE status bar.
//
//   Hover   — cursor is over a proofSuggestion / proofComment /
//             proofProvenance mark. The footer's content is replaced
//             with a one-line description of that mark (source +
//             accepted-at + model for provenance, etc). Leaves the
//             mouse out → back to the default ratio.
//
// Data flow:
//
//   markHoverPlugin → useEditorFooter.setHovered → footer reads
//   docVersionPlugin tick → recompute stats → useEditorFooter.setStats
//                          → footer reads
//
// The recompute walks the ProseMirror doc once per change, summing
// chars covered by proofProvenance marks. For our doc sizes (a few
// thousand chars at most) this is cheap; if it ever shows up in a
// profile, we can debounce or maintain an incremental count.

import { useEffect, useMemo } from 'react'
import type { EditorView } from '@milkdown/kit/prose/view'
import { IconSparklesFilled, IconUserFilled } from '@tabler/icons-react'
import { useEditorFooter, type HoveredMark } from '@/stores/editorFooter'
import { subscribeToPmDocChanges } from '@/editor/docVersionPlugin'
import { UnlinkedNotes } from '@/editor/UnlinkedNotes'

interface Props {
  view: EditorView | null
  parentSlug: string | null
}

export function EditorFooter({ view, parentSlug }: Props) {
  const hovered = useEditorFooter((s) => s.hovered)
  const stats = useEditorFooter((s) => s.stats)
  const setStats = useEditorFooter((s) => s.setStats)

  // Recompute the AI/human stats on every doc-version bump. The
  // version plugin already fires once per content change at the
  // granularity React needs, so we don't have to subscribe to PM
  // transactions directly.
  useEffect(() => {
    if (!view) {
      setStats({ totalChars: 0, aiChars: 0 })
      return
    }
    const recompute = () => setStats(computeStats(view))
    recompute()
    return subscribeToPmDocChanges(recompute)
  }, [view, setStats])

  const aiPct = useMemo(() => {
    if (stats.totalChars === 0) return 0
    return Math.round((stats.aiChars / stats.totalChars) * 100)
  }, [stats])

  const content = hovered
    ? <HoverContent hovered={hovered} />
    : <DefaultContent aiPct={aiPct} totalChars={stats.totalChars} />

  return (
    <div
      className="
        flex shrink-0 items-center justify-between gap-3
        bg-card shadow-[inset_0_1px_0_var(--border)]
        px-4 py-1
        text-[12px] leading-none text-muted-foreground
        select-none
      "
      data-testid="editor-footer"
    >
      <div className="min-w-0 flex-1 truncate">{content}</div>
      <UnlinkedNotes view={view} parentSlug={parentSlug} />
    </div>
  )
}

function DefaultContent({ aiPct, totalChars }: { aiPct: number; totalChars: number }) {
  if (totalChars === 0) {
    return <span className="opacity-60">Empty doc</span>
  }
  const humanPct = 100 - aiPct
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="inline-flex items-center gap-1 opacity-80">
        <IconUserFilled size={11} />
        {humanPct}%
      </span>
      <span className="opacity-40">·</span>
      <span className="inline-flex items-center gap-1 opacity-80">
        <IconSparklesFilled size={11} />
        {aiPct}%
      </span>
    </span>
  )
}

function HoverContent({ hovered }: { hovered: HoveredMark }) {
  if (hovered.kind === 'provenance') {
    const parts: string[] = []
    if (hovered.sourceLabel) parts.push(`From ${hovered.sourceLabel}`)
    if (hovered.acceptedAt) parts.push(formatRelative(hovered.acceptedAt))
    if (hovered.model) parts.push(formatModel(hovered.model))
    return <span className="truncate">{parts.join(' · ') || 'AI-accepted text'}</span>
  }
  if (hovered.kind === 'suggestion') {
    const kind = hovered.suggestionType ?? 'change'
    const tail = hovered.sourceLabel ? ` from ${hovered.sourceLabel}` : ''
    return <span className="truncate">{`Suggested ${kind}${tail}`}</span>
  }
  if (hovered.kind === 'comment') {
    const snippet = (hovered.commentText ?? '').trim()
    return (
      <span className="truncate">
        {snippet ? `Comment: ${snippet}` : 'Comment'}
      </span>
    )
  }
  return <span />
}

// ── helpers ───────────────────────────────────────────────────────

function computeStats(view: EditorView): { totalChars: number; aiChars: number } {
  let total = 0
  let ai = 0
  view.state.doc.descendants((node) => {
    if (!node.isText) return true
    const len = node.text?.length ?? 0
    total += len
    if (node.marks.some((m) => m.type.name === 'proofProvenance')) {
      ai += len
    }
    return true
  })
  return { totalChars: total, aiChars: ai }
}

/** Short relative-time string ("3m ago", "2h ago", "yesterday"). The
 * footer is glanceable; we deliberately keep precision low to avoid
 * the "exact timestamp on hover, summary in footer" pattern's split
 * brain. */
function formatRelative(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return 'recently'
  const diff = Date.now() - then
  const m = Math.round(diff / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  if (d === 1) return 'yesterday'
  if (d < 7) return `${d}d ago`
  const w = Math.round(d / 7)
  if (w < 5) return `${w}w ago`
  // Past ~5 weeks the absolute date is more useful than "12w ago".
  return new Date(iso).toLocaleDateString()
}

/** Trim our internal model identifiers into the user-facing labels
 * the rest of the app uses ('claude-haiku' → 'haiku', etc). */
function formatModel(model: string): string {
  if (model.includes('haiku')) return 'haiku'
  if (model.includes('sonnet')) return 'sonnet'
  if (model.includes('opus')) return 'opus'
  return model
}
