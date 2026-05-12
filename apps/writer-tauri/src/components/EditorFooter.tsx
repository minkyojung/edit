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

import { useEffect, useMemo, useState } from 'react'
import type { EditorView } from '@milkdown/kit/prose/view'
import { IconSparklesFilled, IconUserFilled } from '@tabler/icons-react'
import {
  useEditorFooter,
  type DocStats,
  type HoveredMark,
} from '@/stores/editorFooter'
import { subscribeToPmDocChanges } from '@/editor/docVersionPlugin'
import { UnlinkedNotes } from '@/editor/UnlinkedNotes'
import { formatRelative } from '@/lib/formatRelative'
import { formatModel } from '@/lib/formatModel'

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
      setStats({
        totalChars: 0,
        aiChars: 0,
        wordCount: 0,
        lastAcceptedAt: null,
      })
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

  // Relative-time labels ("3m ago") need to flow even when the user
  // isn't typing. A 60s tick is plenty: under the 60-minute display
  // threshold every visible label changes at most once per minute.
  // The tick is a state bump used only to re-run formatRelative on
  // lastAcceptedAt — it doesn't trigger any other recompute.
  const [, setNow] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => setNow((n) => n + 1), 60_000)
    return () => window.clearInterval(id)
  }, [])

  const content = hovered
    ? <HoverContent hovered={hovered} />
    : (
      <DefaultContent
        aiPct={aiPct}
        totalChars={stats.totalChars}
        wordCount={stats.wordCount}
        lastAcceptedAt={stats.lastAcceptedAt}
      />
    )

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

// Hide the "Last accepted" readout once the event is old enough that
// the label stops being useful — past one hour it's no longer "what
// AI is doing right now in this doc", and competing for footer real
// estate hurts more than it helps.
const LAST_ACCEPTED_VISIBLE_MS = 60 * 60 * 1000

function DefaultContent({
  aiPct,
  totalChars,
  wordCount,
  lastAcceptedAt,
}: {
  aiPct: number
  totalChars: number
  wordCount: number
  lastAcceptedAt: string | null
}) {
  if (totalChars === 0) {
    return <span className="opacity-60">Empty doc</span>
  }
  const humanPct = 100 - aiPct
  const lastAcceptedLabel = useMemo(() => {
    if (!lastAcceptedAt) return null
    const ms = Date.parse(lastAcceptedAt)
    if (Number.isNaN(ms)) return null
    if (Date.now() - ms > LAST_ACCEPTED_VISIBLE_MS) return null
    return formatRelative(lastAcceptedAt)
  }, [lastAcceptedAt])
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="opacity-80">{wordCount.toLocaleString()} words</span>
      <span className="opacity-40">·</span>
      <span className="inline-flex items-center gap-1 opacity-80">
        <IconUserFilled size={11} />
        {humanPct}%
      </span>
      <span className="opacity-40">·</span>
      <span className="inline-flex items-center gap-1 opacity-80">
        <IconSparklesFilled size={11} />
        {aiPct}%
      </span>
      {lastAcceptedLabel && (
        <>
          <span className="opacity-40">·</span>
          <span className="opacity-80">Last accepted {lastAcceptedLabel}</span>
        </>
      )}
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

function computeStats(view: EditorView): DocStats {
  let total = 0
  let ai = 0
  let words = 0
  let latestAcceptMs = 0
  let latestAcceptIso: string | null = null
  view.state.doc.descendants((node) => {
    if (!node.isText) return true
    const text = node.text ?? ''
    total += text.length
    for (const mark of node.marks) {
      if (mark.type.name !== 'proofProvenance') continue
      ai += text.length
      const iso = mark.attrs.acceptedAt as string | null | undefined
      if (!iso) continue
      const ms = Date.parse(iso)
      if (Number.isNaN(ms)) continue
      if (ms > latestAcceptMs) {
        latestAcceptMs = ms
        latestAcceptIso = iso
      }
    }
    // Whitespace split is good enough for English AND for CJK: in
    // Korean, splitting on whitespace gives the natural "eojeol"
    // counting users expect, matching what other editors report.
    // A morpheme-aware tokenizer would be more precise but is way
    // beyond what a status-bar number needs.
    words += text.split(/\s+/).filter(Boolean).length
    return true
  })
  return {
    totalChars: total,
    aiChars: ai,
    wordCount: words,
    lastAcceptedAt: latestAcceptIso,
  }
}

