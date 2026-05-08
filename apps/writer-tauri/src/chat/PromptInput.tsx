// Free-text input for chat. Visual parity with the electron PromptInput
// (rounded container, textarea + bottom-right submit) but kept minimal —
// no attachments, drag-drop, or action menu yet (those land in Step 5/6).
//
// Status flow:
//   idle        → ready to send. Submit button enabled iff value.trim() != ''.
//   streaming   → assistant turn in flight. Submit button toggles to Stop.
//   error       → last send errored. Same as idle but rendered with an error
//                 icon hint; the actual error message lives in the turn.

import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { IconArrowUp, IconPlayerStop, IconQuote, IconX } from '@tabler/icons-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ModelSelect } from '@/chat/ModelSelect'
import { EffortButton } from '@/chat/EffortButton'
import { SlashPalette } from '@/chat/SlashPalette'
import { listCommands, type LoadedCommand } from '@/chat/commands'
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
  /** Currently attached selection text (live or frozen). When set, a
   * preview chip renders above the textarea; null hides the chip. */
  selectionText?: string | null
  /** Detach the selection from this run. Called by the chip's X button. */
  onClearSelection?: () => void
}

// Chip label: first ~24 chars of the selection on a single line, with an
// ellipsis when truncated. Newlines collapse to spaces so the chip stays
// to a single row.
const CHIP_MAX = 24
function chipLabel(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= CHIP_MAX) return flat
  return flat.slice(0, CHIP_MAX).trimEnd() + '…'
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
  selectionText,
  onClearSelection,
}: Props) {
  const [value, setValue] = useState('')
  const [isComposing, setIsComposing] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [isMultiLine, setIsMultiLine] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Switch between horizontal (single-line) and stacked (multi-line) layouts.
  // Hysteresis prevents jitter at the transition boundary: enter multi-line
  // when content visibly wraps past ~1.5 lines; exit only when the user has
  // cleared the field or shrunk it below a length that can't wrap in the
  // single-line layout (otherwise switching back would re-trigger wrap).
  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    if (value.length === 0) {
      setIsMultiLine(false)
      return
    }
    if (value.includes('\n')) {
      setIsMultiLine(true)
      return
    }
    const cs = getComputedStyle(el)
    const lineHeight = parseFloat(cs.lineHeight) || 22
    const padding =
      parseFloat(cs.paddingTop || '0') + parseFloat(cs.paddingBottom || '0')
    const lines = (el.scrollHeight - padding) / lineHeight
    setIsMultiLine((prev) => {
      if (!prev && lines > 1.5) return true
      if (prev && value.length < 30) return false
      return prev
    })
  }, [value])

  const isStreaming = status === 'streaming'
  const trimmed = value.trim()
  const validation = useMemo<ValidationResult>(
    () => (validate && trimmed.length > 0 ? validate(trimmed) : { ok: true }),
    [validate, trimmed],
  )
  const canSubmit =
    !disabled && !isStreaming && trimmed.length > 0 && validation.ok

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
        'relative flex flex-col gap-1.5 rounded-[28px] border border-border/40 bg-muted p-2 transition-colors',
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
      {selectionText && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className={cn(
                'inline-flex w-fit items-center gap-1 rounded-full border border-border',
                'bg-muted/60 px-2 py-0.5 text-xs text-muted-foreground',
              )}
            >
              <IconQuote size={12} stroke={2} className="shrink-0" />
              <span className="font-mono">{chipLabel(selectionText)}</span>
              {onClearSelection && (
                <button
                  type="button"
                  onMouseDown={(e) => {
                    // mousedown so the textarea keeps focus.
                    e.preventDefault()
                    onClearSelection()
                  }}
                  aria-label="Detach selection"
                  className="ml-0.5 rounded-full p-0.5 text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
                >
                  <IconX size={12} stroke={2} />
                </button>
              )}
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" align="start" className="max-w-sm whitespace-pre-wrap text-left">
            {selectionText}
          </TooltipContent>
        </Tooltip>
      )}
      {/* Single-line: [effort] [textarea flex-1] [model + submit] inline.
          Multi-line: textarea takes the full row (w-full forces wrap), then
          effort sits bottom-left and model + submit float to the right via
          ml-auto. DOM order is preserved across modes so the textarea node
          isn't unmounted — keeps focus and IME composition state intact. */}
      <div className="flex flex-wrap items-center gap-2">
        <div
          className={cn(
            'flex items-center gap-1',
            isMultiLine ? 'order-2' : 'order-1',
          )}
        >
          <EffortButton value={effort} onChange={onEffortChange} disabled={isStreaming} />
        </div>
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onCompositionStart={() => setIsComposing(true)}
          onCompositionEnd={() => setIsComposing(false)}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
          className={cn(
            'resize-none bg-transparent text-sm text-foreground outline-none',
            'placeholder:text-muted-foreground',
            '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
            // Single-line mode: lock textarea to the 32px button row height
            // (h-8 + leading-8) so placeholder/text baseline aligns with the
            // effort and submit icons. Multi-line mode reverts to natural
            // line-height so wrapped lines breathe.
            isMultiLine
              ? 'order-1 w-full field-sizing-content max-h-48 min-h-[24px] leading-relaxed'
              : 'order-2 flex-1 min-w-0 h-8 leading-8',
          )}
        />
        <div
          className={cn(
            'flex items-center gap-1',
            isMultiLine ? 'order-3 ml-auto' : 'order-3',
          )}
        >
          <ModelSelect value={model} onChange={onModelChange} disabled={isStreaming} />
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={handleSubmitClick}
                // aria-disabled (not disabled) so the button still fires
                // hover/focus events — that's what makes the tooltip
                // discoverable when validation blocks Send. handleSubmitClick
                // short-circuits via canSubmit, so semantically it's still
                // disabled to clicks.
                aria-disabled={!isStreaming && !canSubmit}
                aria-label={isStreaming ? 'Stop' : 'Send'}
                className={cn(
                  'flex size-8 items-center justify-center rounded-full transition-colors',
                  'outline-none focus-visible:ring-3 focus-visible:ring-ring/30',
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
              ) : !validation.ok && validation.message ? (
                <span>{validation.message}</span>
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
      className="bg-foreground/10 text-foreground/80 font-mono text-xs leading-none px-1 py-0.5"
    >
      {children}
    </kbd>
  )
}
