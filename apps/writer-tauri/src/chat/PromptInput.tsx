// Free-text input for chat. Visual parity with the electron PromptInput
// (rounded container, textarea + bottom-right submit) but kept minimal —
// no attachments, drag-drop, or action menu yet (those land in Step 5/6).
//
// Status flow:
//   idle        → ready to send. Submit button enabled iff value.trim() != ''.
//   streaming   → assistant turn in flight. Submit button toggles to Stop.
//   error       → last send errored. Same as idle but rendered with an error
//                 icon hint; the actual error message lives in the turn.

import { useState, type KeyboardEvent } from 'react'
import { IconArrowUp, IconPlayerStop } from '@tabler/icons-react'
import { cn } from '@/lib/utils'

export type PromptStatus = 'idle' | 'streaming' | 'error'

interface Props {
  status: PromptStatus
  disabled?: boolean
  placeholder?: string
  onSubmit: (text: string) => void
  onStop?: () => void
}

export function PromptInput({
  status,
  disabled,
  placeholder = 'Ask anything about this document',
  onSubmit,
  onStop,
}: Props) {
  const [value, setValue] = useState('')
  const [isComposing, setIsComposing] = useState(false)

  const isStreaming = status === 'streaming'
  const trimmed = value.trim()
  const canSubmit = !disabled && !isStreaming && trimmed.length > 0

  function submit() {
    if (!canSubmit) return
    onSubmit(trimmed)
    setValue('')
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Cmd/Ctrl+Shift+Backspace during streaming = Stop. Bare Esc is
    // deliberately NOT bound — it would clash with the OS-wide habit of
    // dismissing modals/menus and risk accidentally cancelling an answer.
    // The three-key chord requires intent.
    if (
      isStreaming &&
      e.key === 'Backspace' &&
      e.shiftKey &&
      (e.metaKey || e.ctrlKey)
    ) {
      e.preventDefault()
      onStop?.()
      return
    }
    // IME-safe: don't submit while composing (e.g. Korean/Japanese input).
    if (e.key !== 'Enter') return
    if (isComposing || e.nativeEvent.isComposing) return
    if (e.shiftKey) return
    e.preventDefault()
    submit()
  }

  function handleSubmitClick() {
    if (isStreaming) {
      onStop?.()
      return
    }
    submit()
  }

  return (
    <div
      className={cn(
        'flex flex-col gap-2 rounded-2xl border border-border bg-background px-3 py-2.5 transition-colors',
        'focus-within:border-foreground/20',
        disabled && 'opacity-60',
      )}
    >
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onCompositionStart={() => setIsComposing(true)}
        onCompositionEnd={() => setIsComposing(false)}
        placeholder={placeholder}
        disabled={disabled}
        rows={1}
        className={cn(
          'w-full resize-none bg-transparent text-sm leading-relaxed text-foreground outline-none',
          'placeholder:text-muted-foreground',
          'field-sizing-content max-h-48 min-h-[24px]',
          '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        )}
      />

      <div className="flex items-center justify-end">
        <button
          type="button"
          onClick={handleSubmitClick}
          disabled={!isStreaming && !canSubmit}
          aria-label={isStreaming ? 'Stop' : 'Send'}
          className={cn(
            'flex h-7 w-7 items-center justify-center rounded-full transition-colors',
            isStreaming
              ? 'bg-foreground text-background hover:bg-foreground/90'
              : canSubmit
                ? 'bg-foreground text-background hover:bg-foreground/90'
                : 'bg-muted text-muted-foreground cursor-not-allowed',
          )}
        >
          <SubmitIcon status={status} canSubmit={canSubmit} />
        </button>
      </div>
    </div>
  )
}

function SubmitIcon({ status, canSubmit }: { status: PromptStatus; canSubmit: boolean }) {
  if (status === 'streaming') return <IconPlayerStop size={14} stroke={2} />
  return <IconArrowUp size={14} stroke={2} className={cn(!canSubmit && 'opacity-60')} />
}
