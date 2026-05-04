// Free-text input for chat. Visual parity with the electron PromptInput
// (rounded container, textarea + bottom-right submit) but kept minimal —
// no attachments, drag-drop, or action menu yet (those land in Step 5/6).
//
// Status flow:
//   idle        → ready to send. Submit button enabled iff value.trim() != ''.
//   streaming   → assistant turn in flight. Submit button toggles to Stop.
//   error       → last send errored. Same as idle but rendered with an error
//                 icon hint; the actual error message lives in the turn.

import { useMemo, useState, type KeyboardEvent, type ReactNode } from 'react'
import { IconArrowUp, IconPlayerStop } from '@tabler/icons-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ModelSelect } from '@/chat/ModelSelect'
import { EffortButton } from '@/chat/EffortButton'
import { SlashPalette } from '@/chat/SlashPalette'
import { getCommand, listCommands, type LoadedCommand } from '@/chat/commands'
import type { ChatEffort, ChatModel } from '@/chat/types'
import { cn } from '@/lib/utils'

// Matches a slash command at the start of input — `/`, then optional
// kebab-case name, with no whitespace yet. As soon as the user types a
// space the palette closes and we treat the rest as args.
const SLASH_RE = /^\/([a-z][a-z0-9-]*)?$/

// Detect Mac so we render the correct modifier glyph in shortcut hints.
// navigator.platform is deprecated but still the most reliable signal in
// Tauri's webview; userAgent fallback covers any future webview shift.
const IS_MAC =
  typeof navigator !== 'undefined' &&
  (/mac/i.test(navigator.platform) || /mac/i.test(navigator.userAgent))
const MOD_KEY = IS_MAC ? '⌘' : 'Ctrl'

export type PromptStatus = 'idle' | 'streaming' | 'error'

/** Result of pre-submit input validation. When `ok` is false, the parent
 * surfaces `message` as an inline hint and blocks submission. */
export interface ValidationResult {
  ok: boolean
  message?: string
}

interface Props {
  status: PromptStatus
  disabled?: boolean
  placeholder?: string
  onSubmit: (text: string) => void
  onStop?: () => void
  model: ChatModel
  onModelChange: (model: ChatModel) => void
  effort: ChatEffort
  onEffortChange: (effort: ChatEffort) => void
  /** Optional pre-submit validator. Runs on every keystroke; an `ok: false`
   * result both renders an inline hint and prevents Send. */
  validate?: (text: string) => ValidationResult
}

export function PromptInput({
  status,
  disabled,
  placeholder = 'Ask anything about this document',
  onSubmit,
  onStop,
  model,
  onModelChange,
  effort,
  onEffortChange,
  validate,
}: Props) {
  const [value, setValue] = useState('')
  const [isComposing, setIsComposing] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)

  const isStreaming = status === 'streaming'
  const trimmed = value.trim()
  const validation = useMemo<ValidationResult>(
    () => (validate && trimmed.length > 0 ? validate(trimmed) : { ok: true }),
    [validate, trimmed],
  )
  const canSubmit =
    !disabled && !isStreaming && trimmed.length > 0 && validation.ok

  // Argument-hint: when the value is `/<known> ` (palette closed because of
  // the trailing space, no args yet), surface the command's argument-hint
  // as a muted inline cue so the user knows what to type next.
  const argHint = useMemo<string | null>(() => {
    const m = /^\/([a-z][a-z0-9-]*)\s+(.*)$/s.exec(value)
    if (!m) return null
    if (m[2].length > 0) return null
    const cmd = getCommand(m[1])
    return cmd?.argumentHint ?? null
  }, [value])

  // Palette opens while the user is typing the command name itself —
  // before any space. Filter is the partial name (everything after `/`).
  const slashMatch = !isStreaming ? SLASH_RE.exec(value) : null
  const slashQuery = slashMatch?.[1] ?? ''
  const allCommands = useMemo(() => listCommands(), [])
  const filteredCommands = useMemo<LoadedCommand[]>(() => {
    if (!slashMatch) return []
    if (!slashQuery) return allCommands
    return allCommands.filter((c) => c.name.startsWith(slashQuery))
  }, [allCommands, slashMatch, slashQuery])
  const paletteOpen = slashMatch !== null

  // Clamp the highlighted row when the filter shrinks the list.
  const safeIndex = filteredCommands.length === 0
    ? 0
    : Math.min(selectedIndex, filteredCommands.length - 1)

  function pickCommand(cmd: LoadedCommand) {
    // Drop user back into the textarea with `/<name> ` prefilled so they
    // can keep typing args. argument-hint is shown as placeholder via
    // a future polish step (#47).
    setValue(`/${cmd.name} `)
    setSelectedIndex(0)
  }

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

    // Slash palette navigation. We intercept before the textarea sees
    // the keys so cursor/selection inside the input stays put.
    if (paletteOpen && filteredCommands.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex((i) => (i + 1) % filteredCommands.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex(
          (i) => (i - 1 + filteredCommands.length) % filteredCommands.length,
        )
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        if (isComposing || e.nativeEvent.isComposing) return
        e.preventDefault()
        pickCommand(filteredCommands[safeIndex])
        return
      }
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
        'relative flex flex-col gap-2 rounded-2xl border border-border bg-background px-3 py-2.5 transition-colors',
        'focus-within:border-foreground/20',
        disabled && 'opacity-60',
      )}
    >
      {paletteOpen && (
        <SlashPalette
          commands={filteredCommands}
          selectedIndex={safeIndex}
          onSelect={pickCommand}
          onHover={setSelectedIndex}
        />
      )}
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

      {/* Pre-submit hint row. Validation error wins over the muted argument
          hint; both are suppressed while the palette is open so users aren't
          shouted at mid-typing. */}
      {!paletteOpen && !validation.ok && validation.message && (
        <div className="text-xs text-destructive">{validation.message}</div>
      )}
      {!paletteOpen && validation.ok && argHint && (
        <div className="text-xs text-muted-foreground">{argHint}</div>
      )}

      {/* Footer: Tools left, model + submit right. The Tools slot fills in
          on the next phase (effort selector, attachments, etc.); for now it
          just balances the layout via flex justify-between. */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <EffortButton value={effort} onChange={onEffortChange} disabled={isStreaming} />
        </div>
        <div className="flex items-center gap-1">
          <ModelSelect value={model} onChange={onModelChange} disabled={isStreaming} />
        <Tooltip>
          <TooltipTrigger asChild>
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
          </TooltipTrigger>
          <TooltipContent side="top">
            {isStreaming ? (
              <>
                <span>Stop</span>
                <Kbd>{MOD_KEY}</Kbd>
                <Kbd>⇧</Kbd>
                <Kbd>⌫</Kbd>
              </>
            ) : (
              <>
                <span>Send</span>
                <Kbd>⏎</Kbd>
              </>
            )}
          </TooltipContent>
        </Tooltip>
        </div>
      </div>
    </div>
  )
}

function SubmitIcon({ status, canSubmit }: { status: PromptStatus; canSubmit: boolean }) {
  if (status === 'streaming') return <IconPlayerStop size={14} stroke={2} />
  return <IconArrowUp size={14} stroke={2} className={cn(!canSubmit && 'opacity-60')} />
}

/** Inline keyboard glyph used in tooltips. The tooltip CSS auto-styles
 * anything with `data-slot="kbd"` (rounded corners, inset shadow); we just
 * supply the muted text + monospace layer. */
function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd
      data-slot="kbd"
      className="bg-muted text-muted-foreground font-mono text-[10px] leading-none px-1 py-0.5"
    >
      {children}
    </kbd>
  )
}
