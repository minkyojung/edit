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
import {
  IconArrowUp,
  IconFile,
  IconFileText,
  IconFileTypePdf,
  IconMovie,
  IconMusic,
  IconPhoto,
  IconPlayerStop,
  IconQuote,
} from '@tabler/icons-react'
import { classifyAsset, type AssetKind } from '@/lib/attachments'
import { ContextChip } from '@/chat/ContextChip'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ModelSelect } from '@/chat/ModelSelect'
import { EffortButton } from '@/chat/EffortButton'
import { ModeToggle } from '@/chat/ModeToggle'
import { FastToggle } from '@/chat/FastToggle'
import { ContextGauge } from '@/chat/ContextGauge'
import { SlashPalette } from '@/chat/SlashPalette'
import { listCommands, type LoadedCommand } from '@/chat/commands'
import {
  effortsForModel,
  modelSupportsFastMode,
  type ChatEffort,
  type ChatMode,
  type ChatModel,
  type ContextSnapshot,
  type FastModeState,
} from '@/chat/types'
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
  mode: ChatMode
  onModeChange: (mode: ChatMode) => void
  /** Fast-mode request (per-thread). The toggle only renders for models that
   * support fast mode (modelSupportsFastMode). */
  fastMode: boolean
  onFastModeChange: (fastMode: boolean) => void
  /** Actual fast-mode state from the last turn (on / cooldown / off). */
  fastModeState?: FastModeState
  /** Post-turn context-window snapshot for the gauge (left of ModelSelect).
   * Undefined/null until the active thread has completed at least one turn. */
  contextSnapshot?: ContextSnapshot | null
  /** Optional pre-submit validator. Runs on every keystroke; an `ok: false`
   * result both renders an inline hint and prevents Send. */
  validate?: (text: string) => ValidationResult
  /** Currently attached selection text. When set, a chip renders above the
   * textarea (and the text is the chip's tooltip); null hides the chip. */
  selectionText?: string | null
  /** Structured chip label for the selection — e.g. "Note · L10–14". Falls
   * back to a snippet of `selectionText` when absent. */
  selectionLabel?: string | null
  /** Detach the selection from this run. Called by the chip's X button. */
  onClearSelection?: () => void
  /** Vault-relative path of the non-markdown file the chat is reading (the
   * open FileViewer file). When set, a chip renders above the textarea so the
   * user can see the AI has this file in context; null hides it. */
  viewingFilePath?: string | null
  /** Detach the viewed file from the chat's context. Called by the chip's X. */
  onClearViewingFile?: () => void
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

// Per-kind glyph for the viewed-file chip, so a PDF reads as a PDF and an
// image as an image at a glance (classifyAsset maps the extension).
const FILE_KIND_ICON: Record<AssetKind, typeof IconFile> = {
  pdf: IconFileTypePdf,
  image: IconPhoto,
  audio: IconMusic,
  video: IconMovie,
  text: IconFileText,
  other: IconFile,
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
  mode,
  onModeChange,
  fastMode,
  onFastModeChange,
  fastModeState,
  contextSnapshot,
  validate,
  selectionText,
  selectionLabel,
  onClearSelection,
  viewingFilePath,
  onClearViewingFile,
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
        'relative flex flex-col gap-1.5 rounded-3xl bg-muted p-2.5 transition-colors',
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
      {/* Context chips (viewed file, selection, …) live in one horizontal
          row that scrolls sideways when they overflow — the modern chip-bar
          pattern — instead of stacking vertically and growing the composer.
          Each chip is shrink-0 so it keeps its size and the row scrolls. */}
      {(viewingFilePath || selectionText) && (
        <div
          className={cn(
            'flex items-center gap-1.5 overflow-x-auto',
            '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
          )}
        >
      {viewingFilePath && (
        <ContextChip
          icon={FILE_KIND_ICON[classifyAsset(viewingFilePath)]}
          label={viewingFilePath.split('/').pop() ?? viewingFilePath}
          tooltip={viewingFilePath}
          onRemove={onClearViewingFile}
          removeLabel="Remove file from context"
        />
      )}
      {selectionText && (
        <ContextChip
          icon={IconQuote}
          // Prefer the structured "Note · L10–14" label from the editor; fall
          // back to a text snippet when no location is available.
          label={selectionLabel ?? chipLabel(selectionText)}
          tooltip={selectionText}
          onRemove={onClearSelection}
          removeLabel="Detach selection"
        />
      )}
        </div>
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
          'w-full resize-none bg-transparent px-1.5 py-1.5 text-[15px] leading-relaxed text-foreground outline-none',
          'placeholder:text-muted-foreground',
          'field-sizing-content max-h-48 min-h-28',
          '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        )}
      />
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <EffortButton
            value={effort}
            efforts={effortsForModel(model)}
            onChange={onEffortChange}
            disabled={isStreaming}
          />
          {modelSupportsFastMode(model) && (
            <FastToggle
              value={fastMode}
              onChange={onFastModeChange}
              state={fastModeState}
              disabled={isStreaming}
            />
          )}
          <ModeToggle value={mode} onChange={onModeChange} disabled={isStreaming} />
        </div>
        <div className="flex items-center gap-1">
          <ContextGauge snapshot={contextSnapshot} />
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
  if (status === 'streaming') return <IconPlayerStop size={16} stroke={2} />
  return <IconArrowUp size={16} stroke={2} className={cn(!canSubmit && 'opacity-60')} />
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
