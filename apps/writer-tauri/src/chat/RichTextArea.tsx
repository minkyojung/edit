// Rich text field for the chat composer — a contenteditable drop-in for the
// <textarea>, built so attachment / mention chips can later live INLINE in the
// text (the whole reason for the swap). PHASE 1: text-only parity.
//
// Uncontrolled by design: React never rewrites the editor's content after
// mount — doing so on every keystroke resets the caret and breaks IME
// composition. Text flows ONE way, DOM → onChange. The initial value is applied
// once on mount; the composer's draft-store round-trip (thread switch) will
// re-mount the field, which is the only time content is pushed back in.
//
// CARET: line-height MUST be the `normal` keyword, never a numeric ratio —
// WebKit sizes the caret to a numeric line-height's full box (incl. leading),
// so it towers over the glyphs and grows per line. This mirrors the prod
// <textarea> (see PromptInput's line-height comment). A later inline chip must
// therefore be sized to fit UNDER the ~1.2 normal strut, not the other way.
//
// NEWLINES: Shift+Enter is left to the browser (WebKit inserts a <br> and
// manages the trailing-break sentinel so the last empty line is visible — hand-
// inserting '\n' text hits the "needs two presses" trailing-newline bug).
// Serialization walks the node tree and maps <br> / block boundaries back to
// '\n', so the value stays plain text (and Phase 2 can map chip spans to paths).

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type ClipboardEvent,
  type KeyboardEvent,
} from 'react'
import { cn } from '@/lib/utils'

/** An inline, non-editable token embedded in the text flow (attachment or
 * @-mention). `value` is the vault path the chip maps back to on submit. */
export interface ChipData {
  id: string
  kind: 'file' | 'mention'
  label: string
  value: string
}

export interface RichTextAreaHandle {
  focus: () => void
  clear: () => void
  /** Plain text with chips EXCLUDED — attachments/mentions ride as paths. */
  getText: () => string
  /** Chips in document order, for the attachment/mention path lists. */
  getChips: () => ChipData[]
  /** Insert an inline chip at the caret (or at the end if unfocused). */
  insertChip: (chip: ChipData) => void
  /** Replace the entire text content with `text`, caret at end. Used by the
   * slash-command pick (`/name `). */
  setText: (text: string) => void
  /** Delete `backCount` characters before the caret (the `@query` incl. the
   * `@`) and drop a chip in their place. Used by the mention pick. */
  replaceBeforeCaretWithChip: (backCount: number, chip: ChipData) => void
}

interface Props {
  /** Applied to the DOM once on mount (uncontrolled thereafter). */
  initialValue?: string
  placeholder?: string
  disabled?: boolean
  /** Fired on every edit with the serialized plain text. */
  onChange?: (text: string) => void
  /** Enter with no Shift and not composing. */
  onSubmit?: () => void
  /** Fired whenever the caret context may have changed (input / click / arrow).
   * `before` is the plain text from the block start up to the caret — the
   * parent runs its slash / mention regexes on it (the contenteditable
   * equivalent of `textarea.value` up to `selectionStart`). `rect` is the
   * caret's viewport rect, for anchoring a caret-following palette. */
  onCaretContext?: (ctx: { before: string; rect: DOMRect | null }) => void
  /** Called before the editor's own keydown handling. Return true to signal the
   * parent consumed the event (e.g. palette nav) — the editor then skips its
   * Enter/submit logic. Mirrors the textarea path where palette nav intercepts
   * keys before submit. */
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => boolean
  className?: string
}

/** Walk the editor's DOM into plain text: text nodes verbatim, <br> and block
 * boundaries → '\n'. Kept as a standalone fn so Phase 2 can extend the element
 * branch to emit chip tokens. */
function serialize(root: HTMLElement): string {
  const parts: string[] = []
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent ?? '')
      return
    }
    if (node instanceof HTMLElement) {
      // Chips carry their content as a path, not message text — skip entirely.
      if (node.dataset.chipId) return
      if (node.tagName === 'BR') {
        parts.push('\n')
        return
      }
      // WebKit may wrap lines in <div>/<p>; treat each as a line break unless
      // we're already at a fresh line.
      const isBlock = node.tagName === 'DIV' || node.tagName === 'P'
      const last = parts[parts.length - 1]
      if (isBlock && parts.length > 0 && !(last ?? '').endsWith('\n')) {
        parts.push('\n')
      }
      node.childNodes.forEach(walk)
    }
  }
  root.childNodes.forEach(walk)
  return parts.join('')
}

export const RichTextArea = forwardRef<RichTextAreaHandle, Props>(function RichTextArea(
  {
    initialValue = '',
    placeholder,
    disabled,
    onChange,
    onSubmit,
    onCaretContext,
    onKeyDown,
    className,
  },
  ref,
) {
  const editorRef = useRef<HTMLDivElement>(null)
  // Ref (not state) so composition status is readable synchronously inside the
  // keydown handler without a re-render.
  const composingRef = useRef(false)

  useEffect(() => {
    if (initialValue && editorRef.current) {
      editorRef.current.textContent = initialValue
      onChange?.(initialValue)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useImperativeHandle(ref, () => ({
    focus: () => editorRef.current?.focus(),
    clear: () => {
      if (editorRef.current) {
        editorRef.current.innerHTML = ''
        onChange?.('')
      }
    },
    getText: () => (editorRef.current ? serialize(editorRef.current) : ''),
    getChips: () => {
      const editor = editorRef.current
      if (!editor) return []
      return Array.from(editor.querySelectorAll<HTMLElement>('[data-chip-id]')).map((el) => ({
        id: el.dataset.chipId ?? '',
        kind: (el.dataset.chipKind as ChipData['kind']) ?? 'file',
        label: el.dataset.chipLabel ?? el.textContent ?? '',
        value: el.dataset.chipValue ?? '',
      }))
    },
    insertChip: (chip) => insertChipAtCaret(chip),
    setText: (text) => {
      const editor = editorRef.current
      if (!editor) return
      editor.textContent = text
      editor.focus()
      const sel = window.getSelection()
      const r = document.createRange()
      r.selectNodeContents(editor)
      r.collapse(false)
      sel?.removeAllRanges()
      sel?.addRange(r)
      emitChange()
    },
    replaceBeforeCaretWithChip: (backCount, chip) => {
      const editor = editorRef.current
      const sel = window.getSelection()
      if (!editor || !sel || sel.rangeCount === 0) return
      const r = sel.getRangeAt(0)
      const node = r.endContainer
      const end = r.endOffset
      // The `@query` is plain typed text at the caret, so it lives in a single
      // text node — delete `backCount` chars back, then insert the chip there.
      if (node.nodeType === Node.TEXT_NODE && end >= backCount) {
        const del = document.createRange()
        del.setStart(node, end - backCount)
        del.setEnd(node, end)
        del.deleteContents()
        const caret = document.createRange()
        caret.setStart(node, end - backCount)
        caret.collapse(true)
        sel.removeAllRanges()
        sel.addRange(caret)
      }
      insertChipAtCaret(chip)
    },
  }))

  /** Plain text from the block start up to the caret (chips contribute their
   * label text, but the regexes only care about the tail near the caret). */
  function getTextBeforeCaret(): string {
    const editor = editorRef.current
    const sel = window.getSelection()
    if (!editor || !sel || sel.rangeCount === 0) return ''
    const r = sel.getRangeAt(0)
    if (!editor.contains(r.endContainer)) return ''
    const pre = r.cloneRange()
    pre.selectNodeContents(editor)
    pre.setEnd(r.endContainer, r.endOffset)
    return pre.toString()
  }

  /** The caret's viewport rect, for positioning a caret-following palette. A
   * collapsed caret has a valid client rect once there's a character before it
   * (which is always true when a `/`/`@` trigger is active), so no marker-span
   * hack is needed here. */
  function getCaretRect(): DOMRect | null {
    const editor = editorRef.current
    const sel = window.getSelection()
    if (!editor || !sel || sel.rangeCount === 0) return null
    const range = sel.getRangeAt(0)
    if (!editor.contains(range.endContainer)) return null
    const rects = range.getClientRects()
    if (rects.length > 0) return rects[0]
    const r = range.getBoundingClientRect()
    return r.top || r.left || r.width || r.height ? r : null
  }

  function emitCaretContext() {
    onCaretContext?.({ before: getTextBeforeCaret(), rect: getCaretRect() })
  }

  function insertChipAtCaret(chip: ChipData) {
    const editor = editorRef.current
    if (!editor) return
    editor.focus()
    const sel = window.getSelection()
    const range = document.createRange()
    // Use the live caret when it's inside the editor; otherwise append at end.
    if (sel && sel.rangeCount > 0 && sel.anchorNode && editor.contains(sel.anchorNode)) {
      const live = sel.getRangeAt(0)
      range.setStart(live.startContainer, live.startOffset)
      range.collapse(true)
    } else {
      range.selectNodeContents(editor)
      range.collapse(false)
    }
    range.deleteContents()

    const span = document.createElement('span')
    span.contentEditable = 'false'
    span.dataset.chipId = chip.id
    span.dataset.chipKind = chip.kind
    span.dataset.chipLabel = chip.label
    span.dataset.chipValue = chip.value
    // Zero line-shift recipe: the chip must sit ENTIRELY within the text's line
    // box or it nudges the baseline. So —
    //   • display:inline + leading-none → the chip's inline box is just its
    //     13px glyphs, smaller than the 15px text box; align-baseline drops it
    //     inside without pushing the line.
    //   • NO vertical padding (that can perturb the baseline); the pill's
    //     vertical body is drawn by box-shadow spread, which is paint-only and
    //     never affects layout.
    //   • horizontal px is safe (never affects line height/baseline).
    //   • no emoji — emoji glyph metrics inflate the line's ascent.
    span.className =
      'mx-0.5 inline whitespace-nowrap rounded-[5px] bg-accent px-1.5 align-baseline text-[13px] leading-none text-foreground'
    span.style.boxShadow = '0 0 0 2px var(--accent)'
    span.textContent = chip.kind === 'mention' ? `@${chip.label}` : chip.label
    range.insertNode(span)

    // Trailing space so the caret can sit after the chip and typing continues.
    const space = document.createTextNode(' ')
    span.after(space)
    const after = document.createRange()
    after.setStartAfter(space)
    after.collapse(true)
    sel?.removeAllRanges()
    sel?.addRange(after)
    emitChange()
  }

  function emitChange() {
    const editor = editorRef.current
    if (!editor) return
    const text = serialize(editor)
    // Restore the truly-empty DOM when the user deletes everything — WebKit
    // leaves a stray <br> that would (a) suppress the :empty placeholder and
    // (b) count as content. Resetting to '' re-arms the `::before` placeholder
    // and the caret's line box. Caret sits at the start either way, so this is
    // non-disruptive.
    if (text === '' && editor.innerHTML !== '') editor.innerHTML = ''
    onChange?.(text)
    emitCaretContext()
  }

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    // Let the parent claim palette-nav keys (↑↓/Enter/Tab/Esc) BEFORE our own
    // Enter=submit logic — same ordering as the textarea path.
    if (onKeyDown?.(e)) return
    if (e.key !== 'Enter') return
    // IME-safe: never act on Enter mid-composition (Korean/Japanese).
    if (composingRef.current || e.nativeEvent.isComposing) return
    // Shift+Enter → let the browser insert its native line break (<br> + the
    // trailing sentinel). We only claim plain Enter for submit.
    if (e.shiftKey) return
    e.preventDefault()
    onSubmit?.()
  }

  function handlePaste(e: ClipboardEvent<HTMLDivElement>) {
    // Strip formatting: insert plain text at the caret via the browser's own
    // insertion (keeps undo + trailing-break handling correct, unlike a raw
    // text node). insertText is deprecated but the reliable cross-browser way
    // to plain-paste into a contenteditable.
    const text = e.clipboardData?.getData('text/plain') ?? ''
    e.preventDefault()
    document.execCommand('insertText', false, text)
    emitChange()
  }

  return (
    <div
      ref={editorRef}
      contentEditable={!disabled}
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      data-placeholder={placeholder}
      onInput={emitChange}
      onKeyDown={handleKeyDown}
      // Caret can move without an edit (arrows, click) — keep the parent's
      // slash/mention context in sync on those too.
      onKeyUp={emitCaretContext}
      onMouseUp={emitCaretContext}
      onPaste={handlePaste}
      onCompositionStart={() => {
        composingRef.current = true
      }}
      onCompositionEnd={() => {
        composingRef.current = false
        emitChange()
      }}
      className={cn(
        // `leading-[normal]` (keyword) — NOT a numeric ratio — keeps the caret
        // hugging the glyphs (see file header + prod PromptInput).
        'max-h-48 min-h-28 w-full overflow-y-auto whitespace-pre-wrap break-words',
        'bg-transparent px-2.5 py-1.5 text-[15px] leading-[normal] text-foreground outline-none',
        // Placeholder AS the editor's own ::before — this both shows the hint
        // AND gives the empty editor a line box, which is what a WebKit caret
        // anchors to (a truly-empty contenteditable has no caret position).
        'empty:before:pointer-events-none empty:before:text-muted-foreground empty:before:content-[attr(data-placeholder)]',
        '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        className,
      )}
    />
  )
})
