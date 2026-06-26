// Free-text input for chat. Visual parity with the electron PromptInput
// (rounded container, textarea + bottom-right submit) but kept minimal —
// no attachments, drag-drop, or action menu yet (those land in Step 5/6).
//
// Status flow:
//   idle        → ready to send. Submit button enabled iff value.trim() != ''.
//   streaming   → assistant turn in flight. Submit button toggles to Stop.
//   error       → last send errored. Same as idle but rendered with an error
//                 icon hint; the actual error message lives in the turn.

import { useCallback, useMemo, useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode } from 'react'
import { notify } from '@/lib/notify'
import {
  IconArrowUp,
  IconAt,
  IconClipboard,
  IconFile,
  IconFileText,
  IconFileTypePdf,
  IconMovie,
  IconMusic,
  IconPaperclip,
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
import { MentionPalette, type MentionItem } from '@/chat/MentionPalette'
import { listCommands, type LoadedCommand } from '@/chat/commands'
import { useDocsStore } from '@/state/docsStore'
import { pathForDoc } from '@/lib/docPaths'
import { fuzzyScore } from '@/lib/fuzzyMatch'
import {
  effortsForModel,
  modelSupportsFastMode,
  type ChatEffort,
  type ChatMode,
  type ChatModel,
  type ContextSnapshot,
  type FastModeState,
  type FileAttachment,
} from '@/chat/types'
import { cn } from '@/lib/utils'

// Matches a slash command at the start of input — `/`, then optional
// kebab-case name, with no whitespace yet. As soon as the user types a
// space the palette closes and we treat the rest as args.
const SLASH_RE = /^\/([a-z][a-z0-9-]*)?$/

// Matches an `@` mention being typed: `@` at the start of input or after
// whitespace (so emails like `a@b` don't trigger), then the partial query up
// to the next space. The capture group is the query we fuzzy-match on.
const AT_RE = /(?:^|\s)@([^\s@]*)$/

// Caps for the mention list (recents when empty, ranked results otherwise).
const MENTION_RECENTS = 8
const MENTION_RESULTS = 12

const MAX_FILES = 5
const MAX_FILE_SIZE = 20 * 1024 * 1024 // 20 MB — Claude API image limit
const PASTE_AS_CHIP_THRESHOLD = 500 // chars; long pasted text becomes a context chip

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
  onSubmit: (text: string, attachments: FileAttachment[], mentionPaths: string[]) => void
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

function mediaTypeToKind(mediaType: string): AssetKind {
  if (mediaType.startsWith('image/')) return 'image'
  if (mediaType === 'application/pdf') return 'pdf'
  if (mediaType.startsWith('audio/')) return 'audio'
  if (mediaType.startsWith('video/')) return 'video'
  if (mediaType.startsWith('text/')) return 'text'
  return 'other'
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
  const [attachments, setAttachments] = useState<FileAttachment[]>([])
  const [pastedTexts, setPastedTexts] = useState<Array<{ id: string; preview: string; content: string }>>([])
  const [mentions, setMentions] = useState<MentionItem[]>([])
  const knownDocs = useDocsStore((s) => s.knownDocs)
  const [isDragOver, setIsDragOver] = useState(false)
  const dragCounterRef = useRef(0)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const addFiles = useCallback(async (fileList: FileList | File[]) => {
    setAttachments((prev) => {
      const slots = MAX_FILES - prev.length
      if (slots <= 0) {
        notify.attachmentLimitReached()
        return prev
      }
      return prev // proceed; actual append happens after async read below
    })

    const incoming = Array.from(fileList)

    // Validate synchronously before doing any async work.
    const valid: File[] = []
    for (const file of incoming) {
      if (file.size > MAX_FILE_SIZE) {
        notify.attachmentTooLarge(file.name)
        continue
      }
      valid.push(file)
    }
    if (valid.length === 0) return

    const results = await Promise.all(
      valid.map((file) =>
        new Promise<FileAttachment>((resolve) => {
          const reader = new FileReader()
          reader.onload = () =>
            resolve({
              id: crypto.randomUUID(),
              name: file.name,
              mediaType: file.type || 'application/octet-stream',
              dataUrl: reader.result as string,
            })
          reader.readAsDataURL(file)
        }),
      ),
    )

    setAttachments((prev) => {
      const slots = MAX_FILES - prev.length
      if (slots <= 0) return prev
      return [...prev, ...results.slice(0, slots)]
    })
  }, [])

  function removeAttachment(id: string) {
    setAttachments((prev) => prev.filter((a) => a.id !== id))
  }

  function removePastedText(id: string) {
    setPastedTexts((prev) => prev.filter((t) => t.id !== id))
  }

  function handlePaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(e.clipboardData?.items ?? [])
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((f): f is File => f !== null)
    if (files.length > 0) {
      e.preventDefault()
      void addFiles(files)
      return
    }
    const text = e.clipboardData?.getData('text') ?? ''
    if (text.length > PASTE_AS_CHIP_THRESHOLD) {
      e.preventDefault()
      const preview = text.replace(/\s+/g, ' ').trim().slice(0, 60)
      setPastedTexts((prev) => [
        ...prev,
        { id: crypto.randomUUID(), preview, content: text },
      ])
    }
  }

  function handleFileInputChange(e: ChangeEvent<HTMLInputElement>) {
    if (e.currentTarget.files && e.currentTarget.files.length > 0) {
      void addFiles(e.currentTarget.files)
      e.currentTarget.value = ''
    }
  }

  function handleDragEnter(e: DragEvent<HTMLDivElement>) {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    dragCounterRef.current += 1
    if (dragCounterRef.current === 1) setIsDragOver(true)
  }

  function handleDragLeave(e: DragEvent<HTMLDivElement>) {
    if (!e.dataTransfer.types.includes('Files')) return
    dragCounterRef.current -= 1
    if (dragCounterRef.current === 0) setIsDragOver(false)
  }

  function handleDragOver(e: DragEvent<HTMLDivElement>) {
    if (e.dataTransfer.types.includes('Files')) e.preventDefault()
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    dragCounterRef.current = 0
    setIsDragOver(false)
    if (e.dataTransfer.files.length > 0) void addFiles(e.dataTransfer.files)
  }

  const isStreaming = status === 'streaming'
  const trimmed = value.trim()
  const validation = useMemo<ValidationResult>(
    () => (validate && trimmed.length > 0 ? validate(trimmed) : { ok: true }),
    [validate, trimmed],
  )
  const canSubmit =
    !disabled && !isStreaming && (trimmed.length > 0 || pastedTexts.length > 0) && validation.ok

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

  // @-mention candidates: every live note resolved to a vault path (drop ones
  // with no placement). Built once per catalog change; reused for every query.
  const mentionCandidates = useMemo<MentionItem[]>(() => {
    const lookup = new Map(knownDocs.map((d) => [d.slug, d]))
    return knownDocs
      .filter((d) => !d.archivedAt && !d.type.startsWith('system:'))
      .map((d) => {
        const path = pathForDoc(d, (slug) => lookup.get(slug))
        return path
          ? { slug: d.slug, title: d.title || d.relPath || 'Untitled', path }
          : null
      })
      .filter((m): m is MentionItem => m !== null)
  }, [knownDocs])

  // Mention palette opens while typing `@…`. Slash takes priority (its regex is
  // anchored to `^/`, so the two never co-match, but guard anyway).
  const atMatch = !isStreaming ? AT_RE.exec(value) : null
  const atQuery = atMatch?.[1] ?? ''
  const mentionOpen = atMatch !== null && !paletteOpen
  const filteredMentions = useMemo<MentionItem[]>(() => {
    if (!mentionOpen) return []
    if (!atQuery) return mentionCandidates.slice(0, MENTION_RECENTS)
    return mentionCandidates
      .map((m) => ({
        m,
        score: Math.max(fuzzyScore(atQuery, m.title), 0.8 * fuzzyScore(atQuery, m.path)),
      }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MENTION_RESULTS)
      .map((x) => x.m)
  }, [mentionOpen, atQuery, mentionCandidates])

  // Clamp the highlighted row when either palette's filter shrinks the list.
  const activeList = mentionOpen ? filteredMentions : filteredCommands
  const safeIndex = activeList.length === 0
    ? 0
    : Math.min(selectedIndex, activeList.length - 1)

  function pickCommand(cmd: LoadedCommand) {
    // Drop user back into the textarea with `/<name> ` prefilled so they
    // can keep typing args. argument-hint is shown as placeholder via
    // a future polish step (#47).
    setValue(`/${cmd.name} `)
    setSelectedIndex(0)
  }

  function pickMention(item: MentionItem) {
    // Strip the trailing `@query` we were completing — the note is shown as a
    // chip, not inline text. Keep everything up to the `@` (so any leading
    // space before it stays).
    setValue((v) => {
      const m = AT_RE.exec(v)
      if (!m) return v
      const at = v.indexOf('@', m.index)
      return v.slice(0, at)
    })
    setMentions((prev) =>
      prev.some((m) => m.slug === item.slug) ? prev : [...prev, item],
    )
    setSelectedIndex(0)
  }

  function removeMention(slug: string) {
    setMentions((prev) => prev.filter((m) => m.slug !== slug))
  }

  function submit() {
    if (!canSubmit) return
    const context = pastedTexts.map((t) => t.content).join('\n\n')
    const finalText = context && trimmed ? `${context}\n\n${trimmed}` : context || trimmed
    // @-mentioned notes ride along as vault paths via a separate channel (the
    // system prompt), NOT the visible message — so they don't clutter the bubble.
    onSubmit(finalText, attachments, mentions.map((m) => m.path))
    setValue('')
    setAttachments([])
    setPastedTexts([])
    setMentions([])
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

    // Palette navigation (slash commands or @-mentions — only one is open at a
    // time). We intercept before the textarea sees the keys so the cursor /
    // selection inside the input stays put.
    if (activeList.length > 0 && (mentionOpen || paletteOpen)) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex((i) => (i + 1) % activeList.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex((i) => (i - 1 + activeList.length) % activeList.length)
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        if (isComposing || e.nativeEvent.isComposing) return
        e.preventDefault()
        if (mentionOpen) pickMention(filteredMentions[safeIndex])
        else pickCommand(filteredCommands[safeIndex])
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
        'relative flex flex-col gap-1.5 rounded-3xl border-[0.5px] border-border bg-muted dark:bg-[color-mix(in_oklch,var(--muted),black_10%)] p-2.5 transition-colors',
        disabled && 'opacity-60',
      )}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {isDragOver && (
        <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded-3xl border-2 border-dashed border-foreground/30 bg-muted/90 backdrop-blur-sm">
          <IconPaperclip size={28} stroke={1.5} className="text-foreground/50" />
          <span className="text-body font-medium text-foreground/60">Drop files to attach</span>
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/jpeg,image/png,image/gif,image/webp,application/pdf,text/plain,text/csv,text/html,text/markdown,.md"
        className="hidden"
        onChange={handleFileInputChange}
        aria-label="Attach files"
      />
      {paletteOpen && (
        <SlashPalette
          commands={filteredCommands}
          selectedIndex={safeIndex}
          onSelect={pickCommand}
          onHover={setSelectedIndex}
        />
      )}
      {mentionOpen && (
        <MentionPalette
          items={filteredMentions}
          selectedIndex={safeIndex}
          onSelect={pickMention}
          onHover={setSelectedIndex}
        />
      )}
      {/* Context chips (viewed file, selection, …) live in one horizontal
          row that scrolls sideways when they overflow — the modern chip-bar
          pattern — instead of stacking vertically and growing the composer.
          Each chip is shrink-0 so it keeps its size and the row scrolls. */}
      {(viewingFilePath || selectionText || attachments.length > 0 || pastedTexts.length > 0 || mentions.length > 0) && (
        <div
          className={cn(
            'flex items-center gap-1.5 overflow-x-auto',
            '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
          )}
        >
      {mentions.map((m) => (
        <ContextChip
          key={m.slug}
          icon={IconAt}
          label={m.path.split('/').pop() ?? m.title}
          tooltip={m.path}
          onRemove={() => removeMention(m.slug)}
          removeLabel={`Remove ${m.title}`}
          overlayRemove
        />
      ))}
      {attachments.map((att) => (
        <ContextChip
          key={att.id}
          icon={FILE_KIND_ICON[mediaTypeToKind(att.mediaType)]}
          label={att.name.length > CHIP_MAX ? att.name.slice(0, CHIP_MAX) + '…' : att.name}
          tooltip={att.name}
          onRemove={() => removeAttachment(att.id)}
          removeLabel={`Remove ${att.name}`}
        />
      ))}
      {pastedTexts.map((pt) => (
        <ContextChip
          key={pt.id}
          icon={IconClipboard}
          label={chipLabel(pt.preview)}
          onRemove={() => removePastedText(pt.id)}
          removeLabel="Remove pasted text"
        />
      ))}
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
        onPaste={handlePaste}
        placeholder={placeholder}
        disabled={disabled}
        rows={1}
        className={cn(
          // line-height MUST stay the `normal` keyword, not a numeric ratio:
          // WebKit sizes the native caret to a numeric line-height's full box
          // (incl. leading), so e.g. leading-relaxed made the caret tower over
          // the text. `normal` keeps the caret hugging the glyphs.
          'w-full resize-none bg-transparent px-2.5 py-1.5 text-[15px] leading-[normal] text-foreground outline-none',
          'placeholder:text-muted-foreground',
          'field-sizing-content max-h-48 min-h-28',
          '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        )}
      />
      <div className="@container/footer flex items-center justify-between gap-2">
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
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={disabled}
                aria-label="Attach file"
                className={cn(
                  'flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors',
                  'outline-none focus-visible:ring-3 focus-visible:ring-ring/30',
                  'hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50',
                )}
              >
                <IconPaperclip size={18} stroke={1.5} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">Attach file · max 20 MB</TooltipContent>
          </Tooltip>
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
      className="bg-foreground/10 text-foreground/80 font-mono text-footnote leading-none px-1 py-0.5"
    >
      {children}
    </kbd>
  )
}
