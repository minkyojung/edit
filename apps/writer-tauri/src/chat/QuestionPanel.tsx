// Clarifying-question panel for plan mode (AskUserQuestion).
//
// Follows Claude's official question UI: it REPLACES the prompt input while a
// question is parked. One question at a time with a `i of N` pager, numbered
// options (single- or multi-select), a "Something else" free-text row, Skip,
// and a Next/Send button. "Or reply directly…" sends a free-form reply
// instead. Answers go back via `claude_chat_decision` (same turn continues —
// the canonical canUseTool flow). Closing (✕) stops the turn via `onClose`,
// which reuses the existing abort path (the sidecar gate rejects on abort).

import { useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import {
  IconCheck,
  IconChevronLeft,
  IconChevronRight,
  IconPencil,
  IconX,
} from '@tabler/icons-react'
import {
  usePendingPermissions,
  type PendingPermission,
} from '@/state/pendingPermissionsStore'
import { cn } from '@/lib/utils'

interface QOption {
  label: string
  description?: string
}
interface Question {
  question: string
  header?: string
  options?: QOption[]
  multiSelect?: boolean
}

interface Props {
  pending: PendingPermission
  /** Stop the turn (✕). Reuses the host abort path. */
  onClose: () => void
}

export function QuestionPanel({ pending, onClose }: Props) {
  const questions = useMemo<Question[]>(() => {
    const qs = (pending.input as { questions?: Question[] } | null)?.questions
    return Array.isArray(qs) ? qs : []
  }, [pending.input])

  const [index, setIndex] = useState(0)
  const [selections, setSelections] = useState<Record<string, string[]>>({})
  const [custom, setCustom] = useState<Record<string, string>>({})
  const [customOpen, setCustomOpen] = useState<Record<string, boolean>>({})
  const [reply, setReply] = useState('')
  const [sending, setSending] = useState(false)

  if (questions.length === 0) return null

  const q = questions[index]
  const isLast = index === questions.length - 1
  const sel = selections[q.question] ?? []
  const customText = custom[q.question] ?? ''
  const hasAnswer = sel.length > 0 || customText.trim().length > 0

  function toggle(label: string) {
    setSelections((prev) => {
      const cur = prev[q.question] ?? []
      if (q.multiSelect) {
        const next = cur.includes(label)
          ? cur.filter((l) => l !== label)
          : [...cur, label]
        return { ...prev, [q.question]: next }
      }
      return { ...prev, [q.question]: cur.includes(label) ? [] : [label] }
    })
  }

  function buildAnswers(): Record<string, string> {
    const answers: Record<string, string> = {}
    for (const qq of questions) {
      const parts = [...(selections[qq.question] ?? [])]
      const c = custom[qq.question]?.trim()
      if (c) parts.push(c)
      if (parts.length) answers[qq.question] = parts.join(', ')
    }
    return answers
  }

  async function send(decision: unknown) {
    if (sending) return
    setSending(true)
    try {
      await invoke('claude_chat_decision', {
        args: { runId: pending.runId, decisionId: pending.decisionId, decision },
      })
    } catch (err) {
      console.error('[QuestionPanel] decision failed', err)
      setSending(false)
      return
    }
    usePendingPermissions.getState().clearByRun(pending.runId)
  }

  // Next advances; on the last question it submits all collected answers.
  // Skip is the same advance/submit but doesn't require an answer for the
  // current question (unanswered questions are simply omitted).
  function advance() {
    if (isLast) {
      void send({ answers: buildAnswers() })
      return
    }
    setIndex((i) => Math.min(i + 1, questions.length - 1))
  }

  return (
    <div className="rounded-3xl border border-border/40 bg-muted p-3 text-sm">
      {/* Header: question + pager + close */}
      <div className="mb-2 flex items-start justify-between gap-3 px-1">
        <div className="min-w-0">
          {q.header && (
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {q.header}
            </div>
          )}
          <div className="font-medium text-foreground">{q.question}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1 text-muted-foreground">
          {questions.length > 1 && (
            <>
              <button
                type="button"
                onClick={() => setIndex((i) => Math.max(0, i - 1))}
                disabled={index === 0}
                aria-label="이전 질문"
                className="rounded-full p-0.5 hover:bg-accent disabled:opacity-30"
              >
                <IconChevronLeft size={16} />
              </button>
              <span className="text-xs tabular-nums">
                {index + 1} of {questions.length}
              </span>
              <button
                type="button"
                onClick={() => setIndex((i) => Math.min(questions.length - 1, i + 1))}
                disabled={isLast}
                aria-label="다음 질문"
                className="rounded-full p-0.5 hover:bg-accent disabled:opacity-30"
              >
                <IconChevronRight size={16} />
              </button>
            </>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="질문 닫기 (턴 중지)"
            className="ml-1 rounded-full p-0.5 hover:bg-accent hover:text-foreground"
          >
            <IconX size={16} />
          </button>
        </div>
      </div>

      {/* Options */}
      <div className="flex flex-col">
        {(q.options ?? []).map((opt, i) => {
          const on = sel.includes(opt.label)
          return (
            <button
              key={opt.label}
              type="button"
              onClick={() => toggle(opt.label)}
              className={cn(
                'flex items-center gap-3 rounded-xl px-2.5 py-2.5 text-left transition-colors',
                'outline-none focus-visible:ring-3 focus-visible:ring-ring/30',
                on ? 'bg-accent' : 'hover:bg-accent/50',
              )}
            >
              <span
                className={cn(
                  'flex size-6 shrink-0 items-center justify-center rounded-md text-xs',
                  on ? 'bg-foreground text-background' : 'bg-background/60 text-muted-foreground',
                )}
              >
                {i + 1}
              </span>
              <span className="min-w-0 flex-1 truncate text-foreground">{opt.label}</span>
              {on && <IconCheck size={16} className="shrink-0 text-foreground" />}
            </button>
          )
        })}

        {/* Something else (free text for this question) */}
        <div className="flex items-center gap-3 px-2.5 py-2">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-background/60 text-muted-foreground">
            <IconPencil size={14} />
          </span>
          {customOpen[q.question] ? (
            <input
              autoFocus
              value={customText}
              onChange={(e) => setCustom((p) => ({ ...p, [q.question]: e.target.value }))}
              placeholder="직접 입력…"
              className="flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
            />
          ) : (
            <button
              type="button"
              onClick={() => setCustomOpen((p) => ({ ...p, [q.question]: true }))}
              className="flex-1 text-left text-muted-foreground hover:text-foreground"
            >
              Something else
            </button>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="mt-1 flex items-center justify-end gap-2 px-1">
        <button
          type="button"
          onClick={advance}
          disabled={sending}
          className="rounded-full px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          Skip
        </button>
        <button
          type="button"
          onClick={advance}
          disabled={sending || !hasAnswer}
          className={cn(
            'rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
            sending || !hasAnswer
              ? 'cursor-not-allowed bg-muted text-muted-foreground'
              : 'bg-foreground text-background hover:bg-foreground/90',
          )}
        >
          {isLast ? '답변 보내기' : '다음'}
        </button>
      </div>

      {/* Or reply directly — free-form reply (sent as `response`) */}
      <div className="mt-2 flex items-center gap-2 border-t border-border/30 px-1 pt-2">
        <input
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing && reply.trim()) {
              e.preventDefault()
              void send({ response: reply.trim() })
            }
          }}
          placeholder="Or reply directly…"
          className="flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
        />
        {reply.trim() && (
          <button
            type="button"
            onClick={() => void send({ response: reply.trim() })}
            disabled={sending}
            className="rounded-full bg-foreground px-3 py-1 text-xs font-medium text-background hover:bg-foreground/90 disabled:opacity-50"
          >
            보내기
          </button>
        )}
      </div>
    </div>
  )
}
