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

export interface RichTextAreaHandle {
  focus: () => void
  clear: () => void
  getText: () => string
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
  { initialValue = '', placeholder, disabled, onChange, onSubmit, className },
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
  }))

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
  }

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
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
