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
      setStats({ totalChars: 0, aiChars: 0, wordCount: 0 })
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
    : <DefaultContent aiPct={aiPct} totalChars={stats.totalChars} wordCount={stats.wordCount} />

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

function DefaultContent({
  aiPct,
  totalChars,
  wordCount,
}: {
  aiPct: number
  totalChars: number
  wordCount: number
}) {
  if (totalChars === 0) {
    return <span className="opacity-60">Empty doc</span>
  }
  const humanPct = 100 - aiPct
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
  view.state.doc.descendants((node) => {
    if (!node.isText) return true
    const text = node.text ?? ''
    total += text.length
    if (node.marks.some((m) => m.type.name === 'proofProvenance')) {
      ai += text.length
    }
    // Whitespace split is good enough for English AND for CJK: in
    // Korean, splitting on whitespace gives the natural "eojeol"
    // counting users expect, matching what other editors report.
    // A morpheme-aware tokenizer would be more precise but is way
    // beyond what a status-bar number needs.
    words += text.split(/\s+/).filter(Boolean).length
    return true
  })
  return { totalChars: total, aiChars: ai, wordCount: words }
}

