// Clarifying-question card for plan mode (AskUserQuestion).
//
// Renders the SDK's multiple-choice questions inline in the transcript while
// the turn is parked on the user. Each question is single- or multi-select.
// Submitting sends the answers back through `claude_chat_decision`, which
// resolves the sidecar's canUseTool gate so the model continues planning.

import { useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { IconCheck } from '@tabler/icons-react'
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

export function QuestionCard({ pending }: { pending: PendingPermission }) {
  const questions = useMemo<Question[]>(() => {
    const qs = (pending.input as { questions?: Question[] } | null)?.questions
    return Array.isArray(qs) ? qs : []
  }, [pending.input])

  // question text → selected option labels
  const [selections, setSelections] = useState<Record<string, string[]>>({})
  const [sending, setSending] = useState(false)

  const allAnswered = questions.every((q) => (selections[q.question]?.length ?? 0) > 0)

  function toggle(q: Question, label: string) {
    setSelections((prev) => {
      const cur = prev[q.question] ?? []
      if (q.multiSelect) {
        const next = cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]
        return { ...prev, [q.question]: next }
      }
      return { ...prev, [q.question]: [label] }
    })
  }

  async function submit() {
    if (!allAnswered || sending) return
    setSending(true)
    const answers: Record<string, string> = {}
    for (const q of questions) answers[q.question] = (selections[q.question] ?? []).join(', ')
    try {
      await invoke('claude_chat_decision', {
        args: {
          runId: pending.runId,
          decisionId: pending.decisionId,
          decision: { answers },
        },
      })
    } catch (err) {
      console.error('[QuestionCard] decision failed', err)
      setSending(false)
      return
    }
    // The model resumes; drop the card. (Backstopped by the gate listener on
    // run end, but clearing here makes the UI feel immediate.)
    usePendingPermissions.getState().clearByRun(pending.runId)
  }

  if (questions.length === 0) return null

  return (
    <div className="rounded-2xl border border-border/50 bg-muted/40 p-3 text-sm">
      {questions.map((q) => {
        const selected = selections[q.question] ?? []
        return (
          <div key={q.question} className="mb-3 last:mb-0">
            {q.header && (
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {q.header}
              </div>
            )}
            <div className="mb-2 font-medium text-foreground">{q.question}</div>
            <div className="flex flex-col gap-1">
              {(q.options ?? []).map((opt) => {
                const on = selected.includes(opt.label)
                return (
                  <button
                    key={opt.label}
                    type="button"
                    onClick={() => toggle(q, opt.label)}
                    className={cn(
                      'flex items-start gap-2 rounded-xl border px-2.5 py-2 text-left transition-colors',
                      'outline-none focus-visible:ring-3 focus-visible:ring-ring/30',
                      on
                        ? 'border-foreground/30 bg-accent'
                        : 'border-border/40 hover:bg-accent/50',
                    )}
                  >
                    <span
                      className={cn(
                        'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border',
                        on ? 'border-foreground bg-foreground text-background' : 'border-muted-foreground/50',
                      )}
                    >
                      {on && <IconCheck size={11} stroke={3} />}
                    </span>
                    <span>
                      <span className="text-foreground">{opt.label}</span>
                      {opt.description && (
                        <span className="block text-xs text-muted-foreground">{opt.description}</span>
                      )}
                    </span>
                  </button>
                )
              })}
            </div>
            {q.multiSelect && (
              <div className="mt-1 text-xs text-muted-foreground">여러 개 선택 가능</div>
            )}
          </div>
        )
      })}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={submit}
          disabled={!allAnswered || sending}
          className={cn(
            'rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
            'outline-none focus-visible:ring-3 focus-visible:ring-ring/30',
            allAnswered && !sending
              ? 'bg-foreground text-background hover:bg-foreground/90'
              : 'cursor-not-allowed bg-muted text-muted-foreground',
          )}
        >
          {sending ? '보내는 중…' : '답변 보내기'}
        </button>
      </div>
    </div>
  )
}
